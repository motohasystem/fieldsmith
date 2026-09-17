/**
 * アイコン画像のファイル名。
 *
 * 画像そのものを読む必要が無いので、resvg を引き込まないよう render.ts と分けてある。
 * `pull` (spec 層) からも使う。
 */

/**
 * アップロードするアイコン画像のファイル名。
 *
 * **何を描いたかをファイル名に残す。** kintone はアプリアイコンを画像として持つので、
 * 画像そのものからは「🏢 を描いた」ことも「背景色に何を使った」ことも読み取れない。
 * `getAppSettings` は `icon.file.name` を返すので、ここに書いておけば `pull` で戻せる。
 *
 * 人が kintone の画面で差し替えた画像はこの形にならず、その場合は
 * これまで通り「AppSpec には含められません」と伝えることになる。
 */
export function iconFileName(glyph: string, background: string): string {
  return `fieldsmith-icon-${glyph}-${background.replace("#", "")}.png`;
}

/** `iconFileName` が付けた名前を読み戻す。fieldsmith が作ったものでなければ null。 */
export function parseIconFileName(
  name: string,
): { readonly glyph: string; readonly background: string } | null {
  const matched = /^fieldsmith-icon-(.+)-([0-9a-fA-F]{6})\.png$/.exec(name);
  if (matched === null) return null;
  return { glyph: matched[1]!, background: `#${matched[2]!.toLowerCase()}` };
}

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

/**
 * アプリ名から背景色を決める。
 * 同じ名前なら常に同じ色になるので、作り直しても見た目が変わらない。
 */

export function backgroundFor(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
