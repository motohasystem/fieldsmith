import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Noto Color Emoji から絵文字のビットマップを取り出す。
 *
 * なぜこんなことをするのか:
 * Noto Color Emoji は CBDT/CBLC 形式のビットマップフォントで、絵文字の実体は
 * フォント内に埋め込まれた PNG そのもの。一方 resvg はこの形式を描画できず、
 * `<text>` に絵文字を置いても空白になる。
 * ラスタライズは不要で、埋め込まれた PNG をそのまま取り出せば済むため、
 * ここで CBDT を直接読んでいる。
 *
 * @see https://learn.microsoft.com/en-us/typography/opentype/spec/cbdt
 */

/** 絵文字フォントの探索先。fontconfig に頼らず、よくある場所を順に見る。 */
const FONT_CANDIDATES = [
  join(homedir(), ".fonts", "NotoColorEmoji.ttf"),
  join(homedir(), ".local", "share", "fonts", "NotoColorEmoji.ttf"),
  "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
  "/usr/share/fonts/opentype/noto/NotoColorEmoji.ttf",
  "/usr/local/share/fonts/NotoColorEmoji.ttf",
  "/System/Library/Fonts/Apple Color Emoji.ttc",
];

export class EmojiFontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmojiFontError";
  }
}

/** 絵文字フォントのパスを返す。見つからなければ null。 */
export function findEmojiFont(candidates: readonly string[] = FONT_CANDIDATES): string | null {
  return candidates.find((path) => existsSync(path)) ?? null;
}

interface TableDirectory {
  readonly [tag: string]: { readonly offset: number; readonly length: number };
}

function readTables(font: Buffer): TableDirectory {
  const numTables = font.readUInt16BE(4);
  const tables: Record<string, { offset: number; length: number }> = {};
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    const tag = font.toString("latin1", record, record + 4);
    tables[tag] = { offset: font.readUInt32BE(record + 8), length: font.readUInt32BE(record + 12) };
  }
  return tables;
}

/**
 * cmap のサブテーブル (format 4 / 12) から符号位置に対応するグリフ ID を引く。
 * 絵文字は BMP 外なので format 12 が本命だが、念のため format 4 も見る。
 */
function lookupGlyphId(font: Buffer, cmapOffset: number, codePoint: number): number {
  const numTables = font.readUInt16BE(cmapOffset + 2);
  let format12: number | null = null;
  let format4: number | null = null;

  for (let i = 0; i < numTables; i += 1) {
    const record = cmapOffset + 4 + i * 8;
    const subtable = cmapOffset + font.readUInt32BE(record + 4);
    const format = font.readUInt16BE(subtable);
    if (format === 12) format12 = subtable;
    else if (format === 4 && format4 === null) format4 = subtable;
  }

  if (format12 !== null) {
    const numGroups = font.readUInt32BE(format12 + 12);
    for (let i = 0; i < numGroups; i += 1) {
      const group = format12 + 16 + i * 12;
      const start = font.readUInt32BE(group);
      const end = font.readUInt32BE(group + 4);
      if (codePoint >= start && codePoint <= end) {
        return font.readUInt32BE(group + 8) + (codePoint - start);
      }
    }
  }

  if (format4 !== null && codePoint <= 0xffff) {
    const segCountX2 = font.readUInt16BE(format4 + 6);
    const endCodes = format4 + 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;

    for (let i = 0; i < segCountX2 / 2; i += 1) {
      if (codePoint > font.readUInt16BE(endCodes + i * 2)) continue;
      const start = font.readUInt16BE(startCodes + i * 2);
      if (codePoint < start) return 0;

      const rangeOffset = font.readUInt16BE(idRangeOffsets + i * 2);
      if (rangeOffset === 0) {
        return (codePoint + font.readInt16BE(idDeltas + i * 2)) & 0xffff;
      }
      const glyphAddress = idRangeOffsets + i * 2 + rangeOffset + (codePoint - start) * 2;
      const glyph = font.readUInt16BE(glyphAddress);
      return glyph === 0 ? 0 : (glyph + font.readInt16BE(idDeltas + i * 2)) & 0xffff;
    }
  }

  return 0;
}

/** CBLC を辿って、そのグリフの画像データが CBDT のどこにあるかを求める。 */
function locateBitmap(
  font: Buffer,
  cblc: number,
  cbdt: number,
  glyphId: number,
): { offset: number; imageFormat: number } | null {
  const numSizes = font.readUInt32BE(cblc + 4);

  for (let size = 0; size < numSizes; size += 1) {
    // bitmapSize レコードは 48 バイト。先頭が indexSubTableArray への相対オフセット。
    const record = cblc + 8 + size * 48;
    const arrayOffset = font.readUInt32BE(record);
    const numSubTables = font.readUInt32BE(record + 8);

    for (let i = 0; i < numSubTables; i += 1) {
      const entry = cblc + arrayOffset + i * 8;
      const firstGlyph = font.readUInt16BE(entry);
      const lastGlyph = font.readUInt16BE(entry + 2);
      if (glyphId < firstGlyph || glyphId > lastGlyph) continue;

      const subTable = cblc + arrayOffset + font.readUInt32BE(entry + 4);
      const indexFormat = font.readUInt16BE(subTable);
      const imageFormat = font.readUInt16BE(subTable + 2);
      const imageDataOffset = font.readUInt32BE(subTable + 4);

      // indexFormat 1 は 4 バイトのオフセット配列。Noto Color Emoji はこれ。
      if (indexFormat !== 1) continue;
      const index = glyphId - firstGlyph;
      const start = font.readUInt32BE(subTable + 8 + index * 4);
      const end = font.readUInt32BE(subTable + 8 + index * 4 + 4);
      if (end <= start) return null;

      return { offset: cbdt + imageDataOffset + start, imageFormat };
    }
  }
  return null;
}

/**
 * 符号位置に対応する絵文字の PNG を取り出す。該当が無ければ null。
 *
 * 異体字セレクタ (U+FE0F) や肌の色などを含む複数符号位置の絵文字 (ZWJ 連結、国旗) は
 * GSUB による合字で表現されており、ここでは解決できない。呼び出し側で先頭の
 * 符号位置に落として扱う。
 */
export function extractEmojiPng(fontPath: string, codePoint: number): Buffer | null {
  const font = readFileSync(fontPath);
  const tables = readTables(font);

  const cmap = tables["cmap"];
  const cblc = tables["CBLC"];
  const cbdt = tables["CBDT"];
  if (cmap === undefined || cblc === undefined || cbdt === undefined) {
    throw new EmojiFontError(
      `${fontPath} は CBDT 形式のビットマップ絵文字フォントではありません (CBDT/CBLC/cmap が見つかりません)。`,
    );
  }

  const glyphId = lookupGlyphId(font, cmap.offset, codePoint);
  if (glyphId === 0) return null;

  const located = locateBitmap(font, cblc.offset, cbdt.offset, glyphId);
  if (located === null) return null;

  // imageFormat 17: smallGlyphMetrics (5 バイト) + データ長 (4 バイト) + PNG
  // imageFormat 18: bigGlyphMetrics (8 バイト) + データ長 (4 バイト) + PNG
  const headerSize = located.imageFormat === 18 ? 8 : located.imageFormat === 17 ? 5 : -1;
  if (headerSize < 0) return null;

  const lengthAt = located.offset + headerSize;
  const dataLength = font.readUInt32BE(lengthAt);
  const png = font.subarray(lengthAt + 4, lengthAt + 4 + dataLength);

  // 取り出したものが本当に PNG かを確かめる (テーブルの読み違いを黙って通さない)。
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(signature)) return null;

  return Buffer.from(png);
}
