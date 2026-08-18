import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// SDK の zodOutputFormat は zod v4 のスキーマを要求する。
// zod 3.25 は v4 を `zod/v4` として同梱しているので、LLM の入出力スキーマだけこちらを使う。
// このスキーマの値は toAppSpecInput() でただのオブジェクトに落としてからコア (zod v3) に渡すため、
// 2 つのバージョンが混ざることはない。
import * as z from "zod/v4";
import { APP_THEMES, parseAppSpec, type AppSpec } from "../spec/appSpec.js";
import { isOptionFieldType, SUPPORTED_FIELD_TYPES } from "../spec/fieldSpec.js";
import { JSON_SHAPE_INSTRUCTION, SYSTEM_PROMPT } from "./prompt.js";

/**
 * LLM に生成させるスキーマ。
 *
 * コアの AppSpec は型ごとの discriminated union だが、それをそのまま JSON Schema にすると
 * 構造化出力が受け付けない。受け取った後にコアの parseAppSpec() で厳密に検証する二段構えにしている。
 *
 * ここは構造化出力の 2 つの上限に挟まれているため、書き方に強い制約がある。
 *   - `.nullable()` は anyOf (union) になり、「union を持つパラメータは 16 個まで」に当たる
 *   - `.optional()` は union にならないが、キーの出現順が自由になるぶん grammar が膨らみ、
 *     「Schema is too complex」に当たる
 *
 * そこで **すべてのプロパティを必須にし、「指定なし」は空文字・空配列で表す**。
 * union も optional も 0 になり、grammar が最小になる。
 * 空の値は toAppSpecInput() で落とすので、コア側には現れない。
 * この不変条件は tests/llm.test.ts で検証している。
 */
const llmFieldSchema = z.object({
  type: z.enum(SUPPORTED_FIELD_TYPES),
  label: z.string(),
  required: z.boolean(),
  /** 選択肢。RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / DROP_DOWN 以外は空配列。 */
  options: z.array(z.string()),
  /** 計算式。CALC 以外は空文字。 */
  expression: z.string(),
  /** 意味のまとまりの名前。フォームで横に並べる単位になる。 */
  group: z.string(),
});

const llmViewSchema = z.object({
  name: z.string(),
  /** 一覧に表示するフィールド名。 */
  fields: z.array(z.string()),
});

const llmAppSpecSchema = z.object({
  name: z.string(),
  /** アプリの説明。不要なら空文字。 */
  description: z.string(),
  theme: z.enum(APP_THEMES),
  /** アプリアイコンにする絵文字 1 文字。思い当たらなければ空文字。 */
  icon: z.string(),
  /** レコードのタイトルに使うフィールド名。決められなければ空文字。 */
  titleFieldCode: z.string(),
  fields: z.array(llmFieldSchema),
  /** 一覧。不要なら空配列。 */
  views: z.array(llmViewSchema),
});

/**
 * 構造化出力を使わない退避経路で使う、緩いスキーマ。
 * こちらは JSON Schema として送らないので複雑さの上限とは無関係。
 * モデルが項目を省いても既定値で埋めて、コアの検証に持ち込めるようにする。
 */
const llmAppSpecLenientSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  theme: z.enum(APP_THEMES).default("WHITE"),
  icon: z.string().default(""),
  titleFieldCode: z.string().default(""),
  fields: z.array(
    z.object({
      type: z.enum(SUPPORTED_FIELD_TYPES),
      label: z.string(),
      required: z.boolean().default(false),
      options: z.array(z.string()).default([]),
      expression: z.string().default(""),
      group: z.string().default(""),
    }),
  ),
  views: z
    .array(z.object({ name: z.string(), fields: z.array(z.string()).default([]) }))
    .default([]),
});

type LlmAppSpec = z.infer<typeof llmAppSpecSchema>;
type LlmField = z.infer<typeof llmFieldSchema>;

/** スキーマを構造化出力の形式に変換したもの。上限チェックのためテストからも参照する。 */
export const LLM_OUTPUT_FORMAT = zodOutputFormat(llmAppSpecSchema);

export class AppSpecGenerationError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppSpecGenerationError";
  }
}

/**
 * 生成中の進捗。CLI がこれを見て「今なにをしているか」を表示する。
 * 生成は数十秒かかることがあるため、無言の待ち時間を作らないことを重視している。
 */
export type GenerationEvent =
  | {
      readonly type: "connected";
      readonly model: string;
      /** 問い合わせ時に使えるリクエスト ID。 */
      readonly requestId: string | null;
    }
  /** サーバーから届いた生のイベント種別。--verbose での切り分け用。 */
  | { readonly type: "streamEvent"; readonly name: string }
  /** 構造化出力が使えず、JSON を直接書かせる方式に切り替えた。 */
  | { readonly type: "schemaFallback"; readonly reason: string }
  /** モデルが考えている最中。delta は要約された思考の断片。 */
  | { readonly type: "thinking"; readonly delta: string }
  /** 設計 (JSON) を書き出している最中。 */
  | { readonly type: "writing"; readonly delta: string; readonly totalChars: number }
  | {
      readonly type: "done";
      readonly inputTokens: number;
      readonly outputTokens: number;
    };

export interface GenerateOptions {
  readonly model?: string;
  readonly client?: Anthropic;
  /**
   * 1 リクエストの上限時間 (ミリ秒)。
   * SDK の既定は 10 分で、CLI が無反応に見える時間としては長すぎるため短くしている。
   */
  readonly timeoutMs?: number;
  /** 生成に使った LLM の生の応答を観察したいときのフック。 */
  readonly onRawSpec?: (spec: LlmAppSpec) => void;
  /** 生成中の進捗を受け取るフック。 */
  readonly onEvent?: (event: GenerationEvent) => void;
}

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * 1 リクエストの上限時間。
 * SDK の既定は 10 分だが、CLI がそれだけ無反応だと事故と区別が付かないので短くする。
 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 自然文のプロンプトから AppSpec を生成する。
 * LLM の出力は必ずコアのスキーマで再検証するため、この関数が返す値は
 * そのまま deployAppSpec() に渡せる。
 */
export async function generateAppSpec(
  prompt: string,
  options: GenerateOptions = {},
): Promise<AppSpec> {
  const client = options.client ?? new Anthropic();

  const model = options.model ?? DEFAULT_MODEL;
  const notify = options.onEvent ?? (() => {});

  /**
   * 1 回のリクエストを実行する。
   * useSchema が false のときは構造化出力を使わず、JSON を直接書かせる。
   */
  const request = async (useSchema: boolean) => {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 16000,
        // display: "summarized" にしないと thinking の中身は空で流れてくる。
        // 進捗として見せたいので明示する。
        thinking: { type: "adaptive", display: "summarized" },
        system: useSchema ? SYSTEM_PROMPT : SYSTEM_PROMPT + JSON_SHAPE_INSTRUCTION,
        messages: [{ role: "user", content: prompt }],
        ...(useSchema ? { output_config: { format: LLM_OUTPUT_FORMAT } } : {}),
        // 安全性分類器が要求を差し戻した場合に、別モデルへ自動でフォールバックさせる。
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );

    stream.on("connect", () =>
      notify({ type: "connected", model, requestId: stream.request_id ?? null }),
    );
    stream.on("streamEvent", (event) => notify({ type: "streamEvent", name: event.type }));
    stream.on("thinking", (delta) => notify({ type: "thinking", delta }));
    stream.on("text", (delta, snapshot) =>
      notify({ type: "writing", delta, totalChars: snapshot.length }),
    );

    return await stream.finalMessage();
  };

  let response;
  let usedSchema = true;
  try {
    try {
      response = await request(true);
    } catch (error) {
      // 構造化出力には「union は 16 個まで」「grammar が複雑すぎるものは不可」という
      // 上限がある。スキーマを増やすと再発しうるので、弾かれたら JSON を直接
      // 書かせる方式に切り替える。どちらの経路でも結果はコアの検証を通す。
      if (!isSchemaRejected(error)) throw error;
      notify({ type: "schemaFallback", reason: messageOf(error) });
      usedSchema = false;
      response = await request(false);
    }

    notify({
      type: "done",
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      throw new AppSpecGenerationError(
        `${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} 秒待っても応答がなかったため打ち切りました。\n` +
          "  - ネットワークやプロキシの設定を確認してください\n" +
          "  - 要件が複雑な場合は、短く区切って試してください\n" +
          "  - --verbose を付けると、サーバーから届いたイベントを逐次表示します",
        error,
      );
    }
    // その他の API / ネットワーク障害はメッセージがそのまま役に立つので触らない。
    if (error instanceof Anthropic.APIError) throw error;

    if (isMissingCredentials(error)) {
      throw new AppSpecGenerationError(MISSING_CREDENTIALS_MESSAGE, error);
    }

    throw new AppSpecGenerationError(
      `アプリ設計の生成に失敗しました: ${messageOf(error)}`,
      error,
    );
  }

  if (response.stop_reason === "refusal") {
    throw new AppSpecGenerationError(
      "モデルが応答を差し戻しました。プロンプトの内容を見直してください。" +
        (response.stop_details?.explanation === undefined
          ? ""
          : `\n${response.stop_details.explanation}`),
    );
  }

  const raw = usedSchema
    ? response.parsed_output
    : llmAppSpecLenientSchema.safeParse(parseSpecFromText(response)).data;
  if (raw === null || raw === undefined) {
    throw new AppSpecGenerationError(
      "アプリ設計の生成に失敗しました (応答を JSON として解釈できませんでした)。" +
        " プロンプトをより具体的にして再実行してください。",
    );
  }

  options.onRawSpec?.(raw);

  try {
    return parseAppSpec(toAppSpecInput(raw));
  } catch (error) {
    throw new AppSpecGenerationError(
      "生成されたアプリ設計が kintone の制約を満たしていませんでした。" +
        " プロンプトを調整して再実行してください。",
      error,
    );
  }
}

/**
 * LLM の平らな出力を AppSpec の入力形に整える。
 *
 * 構造化出力では「指定しない」を表現するために null を使わせているので、
 * ここで null を落として、型ごとに意味のあるキーだけを残す。
 * 余計なキーが残ると AppSpec 側の strict() で弾かれてしまうため、この選別が必要になる。
 */
export function toAppSpecInput(raw: LlmAppSpec): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    name: raw.name,
    fields: raw.fields.map(toFieldInput),
  };

  assign(spec, "description", raw.description);
  assign(spec, "theme", raw.theme);
  assign(spec, "icon", raw.icon);

  if (raw.views.length > 0) {
    spec["views"] = raw.views.map((view) => ({
      name: view.name,
      type: "LIST",
      ...(view.fields.length > 0 ? { fields: view.fields } : {}),
    }));
  }
  if (raw.titleFieldCode !== "") {
    spec["settings"] = { titleFieldCode: raw.titleFieldCode };
  }
  return spec;
}

function toFieldInput(field: LlmField): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: field.type,
    label: field.label,
    required: field.required,
  };

  if (isOptionFieldType(field.type)) {
    result["options"] = field.options;
  }
  if (field.type === "CALC") {
    result["expression"] = field.expression;
  }
  assign(result, "group", field.group);
  return result;
}

/** 空文字は「指定なし」を表す取り決めなので落とす。 */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined && value !== "") {
    target[key] = value;
  }
}

export const MISSING_CREDENTIALS_MESSAGE =
  "Claude API の認証情報が見つかりません。次のいずれかを設定してください:\n" +
  "  - .env または環境変数に ANTHROPIC_API_KEY を設定する\n" +
  "  - Anthropic CLI (`ant auth login`) でログインする\n" +
  "kintone の認証 (`vck login`) とは別に必要です。";

/** Anthropic SDK が資格情報を解決できなかったときのエラーか。 */
function isMissingCredentials(error: unknown): boolean {
  return (
    error instanceof Error && /Could not resolve authentication method/i.test(error.message)
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 構造化出力のスキーマが受け付けられなかったエラーか。 */
function isSchemaRejected(error: unknown): boolean {
  return (
    error instanceof Anthropic.BadRequestError &&
    /schema/i.test(typeof error.message === "string" ? error.message : "")
  );
}

/**
 * 構造化出力を使わない場合の応答から JSON を取り出す。
 * 前後に説明やコードブロックが付くことがあるので、最初の `{` から最後の `}` までを拾う。
 */
export function parseSpecFromText(response: {
  content: readonly { type: string; text?: string }[];
}): unknown {
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
