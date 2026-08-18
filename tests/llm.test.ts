import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  AppSpecGenerationError,
  generateAppSpec,
  LLM_OUTPUT_FORMAT,
  MISSING_CREDENTIALS_MESSAGE,
  parseSpecFromText,
  toAppSpecInput,
  type GenerationEvent,
} from "../src/llm/generate.js";
import { SYSTEM_PROMPT } from "../src/llm/prompt.js";

type StreamEvent =
  | { readonly on: "connect" }
  | { readonly on: "thinking"; readonly delta: string }
  | { readonly on: "text"; readonly delta: string; readonly snapshot: string };

/**
 * ストリーミング API の偽物。
 * 登録されたハンドラに events を順に流してから finalMessage() を解決する。
 */
function fakeClient(
  response: unknown,
  events: readonly StreamEvent[] = [],
): { client: Anthropic; params: () => Record<string, any> } {
  const stream = vi.fn((params: Record<string, any>) => {
    const handlers = new Map<string, (...args: any[]) => void>();
    return {
      request_id: "req_test",
      on(event: string, handler: (...args: any[]) => void) {
        handlers.set(event, handler);
        return this;
      },
      async finalMessage() {
        for (const event of events) {
          const handler = handlers.get(event.on);
          if (handler === undefined) continue;
          if (event.on === "connect") handler();
          if (event.on === "thinking") handler(event.delta, event.delta);
          if (event.on === "text") handler(event.delta, event.snapshot);
        }
        return response;
      },
      params,
    };
  });

  return {
    client: { beta: { messages: { stream } } } as unknown as Anthropic,
    params: () => stream.mock.calls[0]![0] as Record<string, any>,
  };
}

/**
 * 1 回目のリクエストだけ失敗し、2 回目は成功するクライアント。
 * 構造化出力が弾かれたときの退避経路を検証する。
 */
function fallbackClient(
  firstError: unknown,
  secondResponse: unknown,
): { client: Anthropic; calls: () => Record<string, any>[] } {
  const stream = vi.fn((params: Record<string, any>) => ({
    on() {
      return this;
    },
    async finalMessage() {
      if (stream.mock.calls.length === 1) throw firstError;
      return secondResponse;
    },
  }));
  return {
    client: { beta: { messages: { stream } } } as unknown as Anthropic,
    calls: () => stream.mock.calls.map((c) => c[0] as Record<string, any>),
  };
}

/** finalMessage() が失敗するクライアント。 */
function failingClient(error: unknown): Anthropic {
  return {
    beta: {
      messages: {
        stream: vi.fn(() => ({
          on() {
            return this;
          },
          async finalMessage() {
            throw error;
          },
        })),
      },
    },
  } as unknown as Anthropic;
}

const usage = { input_tokens: 1200, output_tokens: 800 };

/** 省略を空文字・空配列で表す、新しい出力形。 */
type RawField = Parameters<typeof toAppSpecInput>[0]["fields"][number];

const field = (over: Partial<RawField>): RawField => ({
  type: "SINGLE_LINE_TEXT",
  label: "項目",
  required: false,
  options: [],
  expression: "",
  group: "",
  ...over,
});

const rawSpec = {
  name: "案件管理",
  description: "案件を管理します",
  theme: "BLUE" as const,
  icon: "💼",
  titleFieldCode: "案件名",
  fields: [
    field({ label: "案件名", required: true }),
    field({ type: "DROP_DOWN", label: "確度", options: ["高", "中", "低"] }),
  ],
  views: [{ name: "全件", fields: ["案件名", "確度"] }],
};

describe("toAppSpecInput", () => {
  it("空文字・空配列を落として AppSpec の入力形にする", () => {
    expect(toAppSpecInput(rawSpec)).toEqual({
      name: "案件管理",
      description: "案件を管理します",
      theme: "BLUE",
      icon: "💼",
      settings: { titleFieldCode: "案件名" },
      fields: [
        { type: "SINGLE_LINE_TEXT", label: "案件名", required: true },
        { type: "DROP_DOWN", label: "確度", required: false, options: ["高", "中", "低"] },
      ],
      views: [{ name: "全件", type: "LIST", fields: ["案件名", "確度"] }],
    });
  });

  it("空文字で指定された項目は AppSpec に現れない", () => {
    const input = toAppSpecInput({
      ...rawSpec,
      description: "",
      icon: "",
      titleFieldCode: "",
      views: [],
    });
    expect(input).not.toHaveProperty("description");
    expect(input).not.toHaveProperty("icon");
    expect(input).not.toHaveProperty("settings");
    expect(input).not.toHaveProperty("views");
  });

  it("型に無関係なキーを混ぜない (AppSpec の strict 検証を通すため)", () => {
    const input = toAppSpecInput({
      ...rawSpec,
      views: [],
      // 選択肢でない型に options が付いていても落とす。
      fields: [field({ type: "NUMBER", label: "金額", options: ["誤り"], expression: "a * b" })],
    });
    expect(input["fields"]).toEqual([{ type: "NUMBER", label: "金額", required: false }]);
  });

  it("選択肢フィールドの options と CALC の expression は残す", () => {
    const input = toAppSpecInput({
      ...rawSpec,
      views: [],
      fields: [
        field({ type: "DROP_DOWN", label: "区分", options: ["A", "B"] }),
        field({ type: "CALC", label: "合計", expression: "単価 * 数量" }),
      ],
    });
    expect(input["fields"]).toEqual([
      { type: "DROP_DOWN", label: "区分", required: false, options: ["A", "B"] },
      { type: "CALC", label: "合計", required: false, expression: "単価 * 数量" },
    ]);
  });

  it("一覧は LIST として組み立てる", () => {
    const input = toAppSpecInput({ ...rawSpec, views: [{ name: "全件", fields: [] }] });
    expect(input["views"]).toEqual([{ name: "全件", type: "LIST" }]);
  });
});

describe("構造化出力のスキーマ", () => {
  /**
   * 構造化出力は 2 つの上限に挟まれている。
   *   - `.nullable()` は anyOf になり「union は 16 個まで」に当たる
   *   - `.optional()` はキーの出現順が自由になり「Schema is too complex」に当たる
   * どちらも実際に 400 で弾かれたので、両方をここで見張る。
   */
  const walk = (node: unknown, visit: (schema: Record<string, unknown>) => void): void => {
    if (typeof node !== "object" || node === null) return;
    const schema = node as Record<string, unknown>;
    visit(schema);
    for (const value of Object.values(schema["properties"] ?? {})) walk(value, visit);
    if (schema["items"] !== undefined) walk(schema["items"], visit);
  };

  it("union (anyOf / 型の配列) を含まない", () => {
    const unions: unknown[] = [];
    walk(LLM_OUTPUT_FORMAT.schema, (schema) => {
      if ("anyOf" in schema || "oneOf" in schema || Array.isArray(schema["type"])) {
        unions.push(schema);
      }
    });
    expect(unions).toEqual([]);
  });

  it("省略可能なプロパティを持たない (grammar を膨らませないため)", () => {
    const optional: string[] = [];
    walk(LLM_OUTPUT_FORMAT.schema, (schema) => {
      const properties = Object.keys(schema["properties"] ?? {});
      if (properties.length === 0) return;
      const required = new Set((schema["required"] as string[] | undefined) ?? []);
      optional.push(...properties.filter((key) => !required.has(key)));
    });
    expect(optional).toEqual([]);
  });

  it("プロパティ数を抑える", () => {
    let total = 0;
    walk(LLM_OUTPUT_FORMAT.schema, (schema) => {
      total += Object.keys(schema["properties"] ?? {}).length;
    });
    // 26 個で「Schema is too complex」になった実績があるので、余裕を持たせる。
    expect(total).toBeLessThanOrEqual(16);
  });
});

describe("generateAppSpec", () => {
  it("生成結果をコアのスキーマで検証して返す", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", parsed_output: rawSpec, usage });
    const spec = await generateAppSpec("案件管理アプリを作って", { client });

    expect(spec.name).toBe("案件管理");
    expect(spec.fields).toHaveLength(2);
    expect(spec.settings?.titleFieldCode).toBe("案件名");
  });

  it("Claude Opus 5、adaptive thinking、構造化出力を指定してストリーミングする", async () => {
    const { client, params } = fakeClient({ stop_reason: "end_turn", parsed_output: rawSpec, usage });
    await generateAppSpec("案件管理アプリ", { client });

    const p = params();
    expect(p["model"]).toBe("claude-opus-5");
    // display を指定しないと思考が空で流れてくるため、進捗として見せられない。
    expect(p["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(p["system"]).toBe(SYSTEM_PROMPT);
    expect(p["output_config"]["format"]["type"]).toBe("json_schema");
    expect(p["fallbacks"]).toBe("default");
  });

  it("進捗を順に通知する (無言の待ち時間を作らない)", async () => {
    const { client } = fakeClient(
      { stop_reason: "end_turn", parsed_output: rawSpec, usage },
      [
        { on: "connect" },
        { on: "thinking", delta: "案件管理に必要な項目を洗い出す" },
        { on: "text", delta: '{"name"', snapshot: '{"name"' },
        { on: "text", delta: ':"案件管理"', snapshot: '{"name":"案件管理"' },
      ],
    );

    const events: GenerationEvent[] = [];
    await generateAppSpec("案件管理アプリ", { client, onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual([
      "connected",
      "thinking",
      "writing",
      "writing",
      "done",
    ]);
    expect(events[0]).toEqual({
      type: "connected",
      model: "claude-opus-5",
      requestId: "req_test",
    });
    expect(events[1]).toEqual({ type: "thinking", delta: "案件管理に必要な項目を洗い出す" });
    // 書き出しの進み具合が分かるよう、累積の文字数を渡す。
    expect(events[3]).toEqual({ type: "writing", delta: ':"案件管理"', totalChars: 14 });
    expect(events[4]).toEqual({ type: "done", inputTokens: 1200, outputTokens: 800 });
  });

  it("onEvent を渡さなくても動く", async () => {
    const { client } = fakeClient(
      { stop_reason: "end_turn", parsed_output: rawSpec, usage },
      [{ on: "connect" }, { on: "thinking", delta: "考える" }],
    );
    await expect(generateAppSpec("x", { client })).resolves.toBeTruthy();
  });

  it("parsed_output が null なら分かりやすく失敗させる", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", parsed_output: null, usage });
    await expect(generateAppSpec("x", { client })).rejects.toThrow(AppSpecGenerationError);
  });

  it("差し戻し (refusal) を検出する", async () => {
    const { client } = fakeClient({
      stop_reason: "refusal",
      stop_details: { type: "refusal", explanation: "理由" },
      parsed_output: null,
      usage,
    });
    await expect(generateAppSpec("x", { client })).rejects.toThrow(/差し戻しました/);
  });

  it("kintone の制約に反する生成結果は理由付きで弾く", async () => {
    const { client } = fakeClient({
      stop_reason: "end_turn",
      usage,
      parsed_output: {
        name: "案件管理",
        // options が空の DROP_DOWN はコアの検証で弾かれる。
        fields: [{ type: "DROP_DOWN", label: "確度", options: [] }],
      },
    });

    const error = await generateAppSpec("x", { client }).catch(
      (e: unknown) => e as AppSpecGenerationError,
    );
    expect(error).toBeInstanceOf(AppSpecGenerationError);
    expect((error as Error).message).toMatch(/kintone の制約/);
    expect((error as AppSpecGenerationError).cause).toBeInstanceOf(Error);
  });

  it("応答が来ないまま上限に達したら、確認すべきことを添えて打ち切る", async () => {
    const client = failingClient(new Anthropic.APIConnectionTimeoutError({ message: "Request timed out." }));
    const error = await generateAppSpec("x", { client, timeoutMs: 5000 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error!.message).toMatch(/5 秒待っても応答がなかった/);
    expect(error!.message).toMatch(/--verbose/);
  });

  it("スキーマが弾かれたら、構造化出力なしで生成し直す", async () => {
    const schemaError = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "Schema is too complex." } },
      "Schema is too complex.",
      new Headers(),
    );
    const { client, calls } = fallbackClient(schemaError, {
      stop_reason: "end_turn",
      usage,
      content: [
        {
          type: "text",
          text: '説明文\n```json\n{"name":"案件管理","fields":[{"type":"SINGLE_LINE_TEXT","label":"案件名"}]}\n```',
        },
      ],
    });

    const events: GenerationEvent[] = [];
    const spec = await generateAppSpec("案件管理アプリ", {
      client,
      onEvent: (e) => events.push(e),
    });

    expect(spec.name).toBe("案件管理");
    expect(spec.fields).toHaveLength(1);

    // 1 回目は構造化出力あり、2 回目は無しで JSON の形を指示している。
    const [first, second] = calls();
    expect(first!["output_config"]).toBeDefined();
    expect(second!["output_config"]).toBeUndefined();
    expect(second!["system"]).toMatch(/出力形式/);

    expect(events.some((e) => e.type === "schemaFallback")).toBe(true);
  });

  it("スキーマと無関係な 400 では生成し直さない", async () => {
    const other = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "max_tokens is too large" } },
      "max_tokens is too large",
      new Headers(),
    );
    const { client, calls } = fallbackClient(other, { stop_reason: "end_turn", usage, content: [] });

    await expect(generateAppSpec("x", { client })).rejects.toBe(other);
    expect(calls()).toHaveLength(1);
  });

  it("API エラーはそのまま伝える (プロンプトの問題と混同しない)", async () => {
    const apiError = new Anthropic.APIError(500, undefined, "内部エラー", undefined);
    await expect(generateAppSpec("x", { client: failingClient(apiError) })).rejects.toBe(apiError);
  });

  it("スキーマ違反の例外は原因のメッセージを添えて包む", async () => {
    const client = failingClient(new Error("Failed to parse structured output: 詳細"));
    // 原因を握り潰すと切り分けができなくなるので、必ずメッセージを残す。
    await expect(generateAppSpec("x", { client })).rejects.toThrow(
      /Failed to parse structured output: 詳細/,
    );
  });

  it("Claude API の資格情報が無い場合は、その設定方法を案内する", async () => {
    const client = failingClient(
      new Error(
        "Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.",
      ),
    );

    const error = await generateAppSpec("x", { client }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toBe(MISSING_CREDENTIALS_MESSAGE);
    expect(error!.message).toMatch(/ANTHROPIC_API_KEY/);
    // kintone 側の認証と取り違えられやすいので、区別を明示する。
    expect(error!.message).toMatch(/vck login/);
  });
});

describe("退避経路の JSON 抽出", () => {
  const wrap = (text: string) => ({ content: [{ type: "text" as const, text }] });

  it("コードブロックや前置きが付いていても取り出す", () => {
    expect(parseSpecFromText(wrap('前置き\n```json\n{"name":"x"}\n```\n後書き'))).toEqual({
      name: "x",
    });
  });

  it("JSON だけの応答も扱える", () => {
    expect(parseSpecFromText(wrap('{"name":"x"}'))).toEqual({ name: "x" });
  });

  it("JSON が無ければ null", () => {
    expect(parseSpecFromText(wrap("JSON はありません"))).toBeNull();
  });

  it("壊れた JSON なら null (例外を投げない)", () => {
    expect(parseSpecFromText(wrap('{"name": }'))).toBeNull();
  });
});

describe("システムプロンプト", () => {
  it("kintone 固有の落とし穴を明示している", () => {
    expect(SYSTEM_PROMPT).toMatch(/options/);
    expect(SYSTEM_PROMPT).toMatch(/STATUS/);
    expect(SYSTEM_PROMPT).toMatch(/レコード番号/);
    expect(SYSTEM_PROMPT).toMatch(/64 文字以内/);
  });
});
