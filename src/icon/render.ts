import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { extractEmojiPng, findEmojiFont } from "./emojiFont.js";

/** 生成するアイコンの一辺 (px)。kintone の表示に対して十分な解像度。 */
export const ICON_SIZE = 256;

/** kintone がアプリアイコンとして受け付けるファイルサイズの上限。 */
export const MAX_ICON_BYTES = 800 * 1024;

/** 同梱している DotGothic16 のパス。ドット絵風の日本語フォント (OFL-1.1)。 */
export function bundledFontPath(): string {
  // dist/icon/render.js からも src/icon/render.ts からも同じ assets を指すよう遡る。
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "..", "assets", "fonts", "DotGothic16.ttf"),
    join(here, "..", "..", "..", "assets", "fonts", "DotGothic16.ttf"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new IconRenderError("同梱フォント DotGothic16.ttf が見つかりません。");
}

export class IconRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IconRenderError";
  }
}

export interface RenderIconOptions {
  /** 絵文字 1 文字、または 1〜2 文字の頭文字。 */
  readonly glyph: string;
  /** 背景色 (#rrggbb)。省略時はアプリ名から決める。 */
  readonly background: string;
  /** 文字色。 */
  readonly foreground?: string;
  /** 絵文字フォントのパス。省略時は既知の場所から探す。 */
  readonly emojiFontPath?: string | null;
  readonly fontPath?: string;
}

export interface RenderedIcon {
  readonly png: Buffer;
  /** 絵文字として描いたか、文字として描いたか。 */
  readonly mode: "emoji" | "text";
}

/** 絵文字かどうか。異体字セレクタや ZWJ は取り除いてから判定する。 */
export function isEmoji(glyph: string): boolean {
  const base = stripEmojiModifiers(glyph);
  return /\p{Extended_Pictographic}/u.test(base);
}

/**
 * 絵文字から異体字セレクタ・肌の色・ZWJ 連結を取り除いて、代表となる 1 文字にする。
 * CBDT の索引は単一の符号位置しか引けないため、合字は先頭の絵文字で代表させる。
 */
export function stripEmojiModifiers(glyph: string): string {
  const cleaned = glyph
    .replace(/[\uFE0E\uFE0F\u200D]/gu, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  return [...cleaned][0] ?? "";
}

/**
 * アプリ名から背景色を決める。
 * 同じ名前なら常に同じ色になるので、作り直しても見た目が変わらない。
 */
const PALETTE = [
  "#2563eb",
  "#059669",
  "#dc2626",
  "#7c3aed",
  "#ea580c",
  "#0891b2",
  "#c026d3",
  "#65a30d",
] as const;

export function backgroundFor(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

/** アプリ名の先頭 1〜2 文字を頭文字として使う。 */
export function initialsFor(name: string): string {
  const chars = [...name.trim()].filter((char) => !/\s/u.test(char));
  if (chars.length === 0) return "?";
  // 日本語は 1 文字で十分に識別できるが、英字は 2 文字あるほうが読みやすい。
  const isLatin = /^[A-Za-z0-9]$/.test(chars[0]!);
  return isLatin ? chars.slice(0, 2).join("").toUpperCase() : chars[0]!;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** アイコン画像 (PNG) を生成する。 */
export function renderIcon(options: RenderIconOptions): RenderedIcon {
  const { glyph, background } = options;
  const foreground = options.foreground ?? "#ffffff";
  const fontPath = options.fontPath ?? bundledFontPath();
  const radius = Math.round(ICON_SIZE * 0.1875);

  const emojiPng = options.emojiFontPath === null ? null : tryEmojiPng(glyph, options.emojiFontPath);

  const body =
    emojiPng === null
      ? textBody(glyph, foreground)
      : // 絵文字はフォントから取り出した PNG をそのまま合成する。
        `<image x="${ICON_SIZE * 0.1875}" y="${ICON_SIZE * 0.1875}" ` +
        `width="${ICON_SIZE * 0.625}" height="${ICON_SIZE * 0.625}" ` +
        `preserveAspectRatio="xMidYMid meet" ` +
        `href="data:image/png;base64,${emojiPng.toString("base64")}"/>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}">` +
    `<rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="${radius}" fill="${background}"/>` +
    `${body}</svg>`;

  const png = new Resvg(svg, {
    // 同梱フォントだけを使う。実行環境によって見た目が変わらないようにするため。
    font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: "DotGothic16" },
    fitTo: { mode: "width", value: ICON_SIZE },
  })
    .render()
    .asPng();

  if (png.length > MAX_ICON_BYTES) {
    throw new IconRenderError(
      `生成したアイコンが ${Math.round(png.length / 1024)}KB になり、kintone の上限 800KB を超えました。`,
    );
  }

  return { png: Buffer.from(png), mode: emojiPng === null ? "text" : "emoji" };
}

function textBody(glyph: string, foreground: string): string {
  const characters = [...glyph].length;
  // 文字数に応じて、はみ出さない大きさに落とす。
  const fontSize = characters >= 3 ? 72 : characters === 2 ? 104 : 148;
  return (
    `<text x="${ICON_SIZE / 2}" y="${ICON_SIZE / 2}" font-size="${fontSize}" ` +
    `text-anchor="middle" dominant-baseline="central" fill="${foreground}" ` +
    `font-family="DotGothic16">${escapeXml(glyph)}</text>`
  );
}

function tryEmojiPng(glyph: string, fontPath?: string): Buffer | null {
  if (!isEmoji(glyph)) return null;

  const path = fontPath ?? findEmojiFont();
  if (path === null) return null;

  const base = stripEmojiModifiers(glyph);
  const codePoint = base.codePointAt(0);
  if (codePoint === undefined) return null;

  try {
    return extractEmojiPng(path, codePoint);
  } catch {
    // 絵文字を描けないことはアイコンを諦める理由にならない。文字として描く。
    return null;
  }
}
