import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptInputError, resolvePrompt } from "../src/cli/promptInput.js";

describe("プロンプトの入力元", () => {
  it("引数から読む", () => {
    expect(resolvePrompt({ argument: "案件管理アプリ" })).toEqual({
      text: "案件管理アプリ",
      source: "コマンドライン引数",
    });
  });

  it("ファイルから読む", () => {
    const dir = mkdtempSync(join(tmpdir(), "fieldsmith-prompt-"));
    const path = join(dir, "requirements.md");
    writeFileSync(path, "# 案件管理\n\n案件名、顧客名、金額を管理する。\n");

    const input = resolvePrompt({ filePath: path });
    expect(input.text).toBe("# 案件管理\n\n案件名、顧客名、金額を管理する。");
    expect(input.source).toBe(path);
  });

  it("改行や引用符を含む長い要件をそのまま渡せる", () => {
    // シェルの引数では扱いにくいものが、ファイル経由なら素通しできることを確かめる。
    const text = '複数行の要件\n"引用符" と（全角括弧）と $変数 を含む\n- 箇条書き';
    const input = resolvePrompt({ filePath: "req.md", readFile: () => text });
    expect(input.text).toBe(text);
  });

  it("`-` なら標準入力から読む", () => {
    const input = resolvePrompt({ filePath: "-", readStdin: () => "標準入力の要件\n" });
    expect(input).toEqual({ text: "標準入力の要件", source: "標準入力" });
  });

  it("前後の空白を落とす", () => {
    expect(resolvePrompt({ argument: "  案件管理  " }).text).toBe("案件管理");
    expect(resolvePrompt({ filePath: "x", readFile: () => "\n\n要件\n\n" }).text).toBe("要件");
  });

  it("引数とファイルの両方を指定したら弾く (どちらが使われるか曖昧にしない)", () => {
    expect(() => resolvePrompt({ argument: "A", filePath: "b.md" })).toThrow(
      /どちらか一方/,
    );
  });

  it("どちらも無ければ、使い方を示して弾く", () => {
    const error = (() => {
      try {
        resolvePrompt({});
      } catch (e) {
        return e as Error;
      }
      throw new Error("エラーになりませんでした");
    })();

    expect(error).toBeInstanceOf(PromptInputError);
    expect(error.message).toMatch(/--prompt-file/);
    expect(error.message).toMatch(/標準入力/);
  });

  it("空文字の引数は指定なしとして扱う", () => {
    expect(() => resolvePrompt({ argument: "   " })).toThrow(PromptInputError);
  });

  it("空のファイルを弾く", () => {
    expect(() => resolvePrompt({ filePath: "empty.md", readFile: () => "\n \n" })).toThrow(
      /empty\.md が空です/,
    );
  });

  it("読めないファイルはパスを添えて弾く", () => {
    expect(() =>
      resolvePrompt({
        filePath: "/no/such/file.md",
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/\/no\/such\/file\.md/);
  });

  it("標準入力が空なら弾く", () => {
    expect(() => resolvePrompt({ filePath: "-", readStdin: () => "" })).toThrow(
      /標準入力が空です/,
    );
  });

  it("引数が空文字でもファイル指定があれば重複扱いにしない", () => {
    expect(resolvePrompt({ argument: "", filePath: "x", readFile: () => "要件" }).text).toBe(
      "要件",
    );
  });
});
