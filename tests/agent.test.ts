import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, EXIT_HINT } from "../src/cli/exit.js";
import { emitFailure, emitSuccess, say, setJsonMode } from "../src/cli/output.js";
import { appSpecExample, appSpecJsonSchema, appSpecReference } from "../src/cli/schema.js";
import { parseAppSpec } from "../src/spec/appSpec.js";
import { describeFieldTypes, SUPPORTED_FIELD_TYPES, UNADDABLE_FIELD_TYPES } from "../src/spec/fieldSpec.js";
import { toKintonePayloads } from "../src/spec/toKintone.js";

/**
 * AI エージェントから呼ばれる前提の振る舞い。
 * stdout が機械可読であること、失敗の種類が終了コードで分かることを固定する。
 */

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.join(" "));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
  process.exitCode = undefined;
});

const parseStdout = (): unknown => JSON.parse(stdout.join(""));

describe("--json のときの出力先", () => {
  it("人間向けの文言は stderr に回り、stdout は JSON だけになる", () => {
    setJsonMode(true);
    say("デプロイしています");
    emitSuccess({ command: "deploy", app: { id: "752" } });

    // エージェントは stdout をそのまま JSON.parse できる。
    expect(parseStdout()).toEqual({ ok: true, command: "deploy", app: { id: "752" } });
    expect(stderr.join("")).toContain("デプロイしています");
  });

  it("既定では人間向けの文言が stdout に出て、JSON は出さない", () => {
    setJsonMode(false);
    say("デプロイしています");
    emitSuccess({ command: "deploy", app: { id: "752" } });

    expect(stdout.join("")).toBe("デプロイしています\n");
  });
});

describe("失敗の分類", () => {
  it.each([
    ["validation", 2],
    ["auth", 3],
    ["config", 4],
    ["kintone", 5],
    ["generation", 6],
    ["input", 7],
  ] as const)("%s は終了コード %d", (kind, code) => {
    emitFailure({ command: "deploy", kind, message: "エラー" });
    expect(process.exitCode).toBe(code);
    expect(EXIT[kind]).toBe(code);
  });

  it("成功は 0、想定外は 1", () => {
    expect(EXIT.ok).toBe(0);
    expect(EXIT.unknown).toBe(1);
  });

  it("すべての分類に、次にとるべき行動が書かれている", () => {
    for (const kind of Object.keys(EXIT) as (keyof typeof EXIT)[]) {
      expect(EXIT_HINT[kind]).toBeTruthy();
    }
  });

  it("--json なら、原因と次の一手を機械可読で返す", () => {
    setJsonMode(true);
    emitFailure({
      command: "deploy",
      kind: "validation",
      message: "AppSpec の検証に失敗しました",
      issues: [{ path: "fields.0.type", message: "STATUS は追加できません" }],
    });

    expect(parseStdout()).toEqual({
      ok: false,
      command: "deploy",
      error: {
        kind: "validation",
        exitCode: 2,
        hint: EXIT_HINT.validation,
        message: "AppSpec の検証に失敗しました",
        issues: [{ path: "fields.0.type", message: "STATUS は追加できません" }],
      },
    });
  });

  it("途中まで進んでいた場合は appId を含める", () => {
    setJsonMode(true);
    emitFailure({ command: "deploy", kind: "kintone", message: "失敗", appId: "752" });
    expect((parseStdout() as { error: { appId: string } }).error.appId).toBe("752");
  });

  it("appId が無ければキーごと出さない", () => {
    setJsonMode(true);
    emitFailure({ command: "deploy", kind: "kintone", message: "失敗", appId: null });
    expect(parseStdout()).not.toHaveProperty("error.appId");
  });
});

describe("fieldsmith schema", () => {
  it("実例はそのままデプロイできる", () => {
    // ここが壊れると、エージェントは動かない spec を掴まされる。
    const spec = parseAppSpec(appSpecExample());
    expect(spec.fields.length).toBeGreaterThan(0);
    expect(() => toKintonePayloads(spec)).not.toThrow();
  });

  it("実例が主な機能を一通り含む", () => {
    const spec = parseAppSpec(appSpecExample());
    expect(spec.icon).toBeDefined();
    expect(spec.views?.length).toBeGreaterThan(1);
    expect(spec.settings?.titleFieldCode).toBeDefined();
    expect(spec.fields.some((field) => field.group !== undefined)).toBe(true);
    expect(spec.fields.some((field) => "options" in field)).toBe(true);
  });

  it("対応するフィールド型をすべて載せる (実装とずれない)", () => {
    const reference = appSpecReference();
    for (const type of SUPPORTED_FIELD_TYPES) {
      expect(reference).toContain(`\`${type}\``);
    }
  });

  it("指定できない型とその理由も載せる", () => {
    const reference = appSpecReference();
    for (const type of Object.keys(UNADDABLE_FIELD_TYPES)) {
      expect(reference).toContain(`\`${type}\``);
    }
  });

  it("認証なしで検証できることを案内する", () => {
    expect(appSpecReference()).toContain("--dry-run");
  });

  it("JSON Schema を出力できる", () => {
    const schema = appSpecJsonSchema() as { definitions: { AppSpec: { required: string[] } } };
    expect(schema.definitions.AppSpec.required).toEqual(["name", "fields"]);
  });
});

describe("フィールド型の一覧の導出", () => {
  it("Zod の定義から全型を引き出す", () => {
    const described = describeFieldTypes().map((entry) => entry.type);
    expect(described.sort()).toEqual([...SUPPORTED_FIELD_TYPES].sort());
  });

  it("必須と任意を区別する", () => {
    const text = describeFieldTypes().find((entry) => entry.type === "SINGLE_LINE_TEXT")!;
    expect(text.keys.find((key) => key.name === "label")!.required).toBe(true);
    expect(text.keys.find((key) => key.name === "code")!.required).toBe(false);
  });

  it("選択肢の型は options を必須として示す", () => {
    const dropdown = describeFieldTypes().find((entry) => entry.type === "DROP_DOWN")!;
    expect(dropdown.keys.find((key) => key.name === "options")!.required).toBe(true);
  });

  it("CALC は expression を必須として示す", () => {
    const calc = describeFieldTypes().find((entry) => entry.type === "CALC")!;
    expect(calc.keys.find((key) => key.name === "expression")!.required).toBe(true);
  });
});
