import { describe, expect, it } from "vitest";
import { extractEmojiPng, findEmojiFont } from "../src/icon/emojiFont.js";
import {
  backgroundFor,
  ICON_SIZE,
  initialsFor,
  isEmoji,
  renderIcon,
  stripEmojiModifiers,
} from "../src/icon/render.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG のヘッダから画像サイズを読む。 */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("絵文字の判定", () => {
  it.each(["📚", "💼", "🗂", "✅"])("%s を絵文字と判定する", (glyph) => {
    expect(isEmoji(glyph)).toBe(true);
  });

  it.each(["書", "A", "1", "案"])("%s は絵文字ではない", (glyph) => {
    expect(isEmoji(glyph)).toBe(false);
  });

  it("異体字セレクタや肌の色を落として代表の 1 文字にする", () => {
    expect(stripEmojiModifiers("✅️")).toBe("✅");
    expect(stripEmojiModifiers("\u{1F44D}\u{1F3FD}")).toBe("\u{1F44D}");
    // ZWJ で連結した絵文字は先頭で代表させる。
    expect(stripEmojiModifiers("\u{1F468}‍\u{1F4BB}")).toBe("\u{1F468}");
  });
});

describe("背景色", () => {
  it("同じアプリ名なら常に同じ色になる", () => {
    expect(backgroundFor("案件管理")).toBe(backgroundFor("案件管理"));
  });

  it("名前が違えば色も散る", () => {
    const colors = new Set(
      ["案件管理", "書籍管理", "問い合わせ", "在庫", "勤怠"].map(backgroundFor),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("必ず #rrggbb を返す", () => {
    expect(backgroundFor("なんでも")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("頭文字", () => {
  it("日本語は 1 文字", () => {
    expect(initialsFor("案件管理")).toBe("案");
  });

  it("英字は 2 文字にして大文字にする", () => {
    expect(initialsFor("sales pipeline")).toBe("SA");
  });

  it("前後の空白を無視する", () => {
    expect(initialsFor("  書籍管理  ")).toBe("書");
  });

  it("空文字でも落ちない", () => {
    expect(initialsFor("   ")).toBe("?");
  });
});

describe("アイコン生成", () => {
  it("日本語の頭文字から PNG を作る", () => {
    const { png, mode } = renderIcon({ glyph: "書", background: "#059669" });

    expect(mode).toBe("text");
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(pngSize(png)).toEqual({ width: ICON_SIZE, height: ICON_SIZE });
  });

  it("複数文字でも収まる大きさで描く", () => {
    const one = renderIcon({ glyph: "書", background: "#059669" }).png;
    const three = renderIcon({ glyph: "案件管", background: "#059669" }).png;
    expect(pngSize(one)).toEqual(pngSize(three));
  });

  it("XML として危険な文字を混ぜられても壊れない", () => {
    // SVG を組み立てているので、エスケープ漏れは描画失敗になって現れる。
    const { png } = renderIcon({ glyph: "<&>", background: "#059669" });
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("背景色が変われば画像も変わる", () => {
    const blue = renderIcon({ glyph: "書", background: "#2563eb" }).png;
    const green = renderIcon({ glyph: "書", background: "#059669" }).png;
    expect(blue.equals(green)).toBe(false);
  });

  it("同じ入力なら同じ画像になる (作り直しても見た目が変わらない)", () => {
    const first = renderIcon({ glyph: "書", background: "#2563eb" }).png;
    const second = renderIcon({ glyph: "書", background: "#2563eb" }).png;
    expect(first.equals(second)).toBe(true);
  });

  it("絵文字フォントが無ければ文字として描く (アイコンを諦めない)", () => {
    const { png, mode } = renderIcon({
      glyph: "📚",
      background: "#2563eb",
      emojiFontPath: null,
    });
    expect(mode).toBe("text");
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });
});

// 絵文字フォントは環境依存なので、見つかるときだけ検証する。
const emojiFont = findEmojiFont();

describe.skipIf(emojiFont === null)("絵文字アイコン", () => {
  it("フォントから絵文字の PNG を取り出せる", () => {
    // 📚 U+1F4DA
    const png = extractEmojiPng(emojiFont!, 0x1f4da);
    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("フォントに無い符号位置なら null を返す", () => {
    // 私用領域。絵文字フォントには入っていない。
    expect(extractEmojiPng(emojiFont!, 0xe000)).toBeNull();
  });

  it("絵文字を合成したアイコンを作る", () => {
    const { png, mode } = renderIcon({ glyph: "📚", background: "#2563eb" });

    expect(mode).toBe("emoji");
    expect(pngSize(png)).toEqual({ width: ICON_SIZE, height: ICON_SIZE });
    // 単色の文字より、写実的な絵文字のほうが必ず情報量が多くなる。
    const textIcon = renderIcon({ glyph: "書", background: "#2563eb" }).png;
    expect(png.length).toBeGreaterThan(textIcon.length);
  });

  it("異体字セレクタ付きの絵文字も描ける", () => {
    expect(renderIcon({ glyph: "✅️", background: "#2563eb" }).mode).toBe("emoji");
  });
});
