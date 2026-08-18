import { describe, expect, it } from "vitest";
import { startStatusLine, tailLine } from "../src/cli/progress.js";

/** 書き込み内容を集める偽の出力先。 */
function fakeStream() {
  const chunks: string[] = [];
  return {
    stream: { write: (text: string) => chunks.push(text) } as unknown as NodeJS.WriteStream,
    output: () => chunks.join(""),
    chunks,
  };
}

const noopTimers = {
  setIntervalImpl: (() => ({ unref: () => {} })) as unknown as typeof setInterval,
  clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
};

describe("ステータス行", () => {
  it("TTY では 1 行を書き換える (行が増えない)", () => {
    const { stream, output } = fakeStream();
    let clock = 0;

    const status = startStatusLine("接続しています", {
      stream,
      isTty: true,
      now: () => clock,
      ...noopTimers,
    });
    clock = 3000;
    status.update("設計を考えています");
    clock = 12000;
    status.update("設計を書き出しています");
    status.done("✓ 完了");

    const text = output();
    // 途中経過に改行は含まれず、確定した 1 行だけが残る。
    expect(text.split("\n").filter((line) => line !== "")).toHaveLength(1);
    expect(text).toContain("設計を考えています (3秒)");
    expect(text).toContain("設計を書き出しています (12秒)");
    expect(text).toContain("✓ 完了");
  });

  it("TTY でなければ update は出さない (log と二重に出さないため)", () => {
    const { stream, output } = fakeStream();
    const status = startStatusLine("接続しています", {
      stream,
      isTty: false,
      now: () => 0,
      ...noopTimers,
    });
    status.update("設計を考えています");
    status.log("  設計を考えています");
    status.done("✓ 完了");

    // 動きを見せる表示は出ず、履歴として残したものだけが出る。
    expect(output()).toBe("接続しています\n  設計を考えています\n✓ 完了\n");
    // パイプやログファイルに ANSI エスケープが混ざらないこと。
    expect(output()).not.toContain("\u001b");
  });

  it("同じ文言での更新は無視する (ちらつきを防ぐ)", () => {
    const { stream, chunks } = fakeStream();
    let clock = 0;
    const status = startStatusLine("待機中", {
      stream,
      isTty: true,
      now: () => clock,
      ...noopTimers,
    });
    const before = chunks.length;
    status.update("待機中");
    status.update("待機中");
    expect(chunks.length).toBe(before);
    status.done();
  });

  it("done を二重に呼んでも出力が重複しない", () => {
    const { stream, chunks } = fakeStream();
    const status = startStatusLine("処理中", { stream, isTty: false, now: () => 0, ...noopTimers });
    status.done("✓ 完了");
    status.done("✓ 完了");
    expect(chunks.filter((c) => c.includes("完了"))).toHaveLength(1);
  });

  it("done の後の update は無視する", () => {
    const { stream, output } = fakeStream();
    const status = startStatusLine("処理中", { stream, isTty: false, now: () => 0, ...noopTimers });
    status.done();
    status.update("あとから来た更新");
    status.log("あとから来た履歴");
    expect(output()).not.toContain("あとから来た更新");
  });

  it("log は履歴として残り、ステータス行はその下に描き直される", () => {
    const { stream, output } = fakeStream();
    let clock = 0;
    const status = startStatusLine("開始しています", {
      stream,
      isTty: true,
      now: () => clock,
      ...noopTimers,
    });
    clock = 2000;
    status.log("  アプリを作成しました");
    status.update("フィールドを追加しています");
    status.done();

    const text = output();
    // 履歴行は残る。
    expect(text).toContain("アプリを作成しました\n");
    // 履歴を出したあともステータス行が描き直されている。
    expect(text.indexOf("フィールドを追加しています")).toBeGreaterThan(
      text.indexOf("アプリを作成しました"),
    );
  });

  it("TTY でなければ log も普通の行として出す", () => {
    const { stream, chunks } = fakeStream();
    const status = startStatusLine("開始", { stream, isTty: false, now: () => 0, ...noopTimers });
    status.log("  完了");
    status.done();
    expect(chunks).toEqual(["開始\n", "  完了\n"]);
  });

  it("経過秒数を返す", () => {
    let clock = 1000;
    const { stream } = fakeStream();
    const status = startStatusLine("処理中", {
      stream,
      isTty: false,
      now: () => clock,
      ...noopTimers,
    });
    clock = 46_500;
    expect(status.elapsedSeconds()).toBe(45);
  });
});

describe("tailLine", () => {
  it("改行や連続する空白を畳んで 1 行にする", () => {
    expect(tailLine("あ\nい\t う  え", 100)).toBe("あ い う え");
  });

  it("長い場合は末尾を残す (いま何を考えているかを見せる)", () => {
    expect(tailLine("あいうえおかきくけこ", 5)).toBe("…かきくけこ");
  });

  it("収まる場合はそのまま", () => {
    expect(tailLine("短い", 10)).toBe("短い");
  });
});
