import type { KintoneProperties } from "./fromKintone.js";
import type { LayoutRow } from "./layout.js";

/**
 * フォームの構造を人が読める形にする。
 *
 * `pull` は AppSpec を吐くので、**構造を把握するには読みにくい**。
 * フィールド定義が縦に長く、どれが同じ行に並んでいるのかが見えない。
 * 「このフィールドの近くに何かを置きたい」ときに要るのは、定義ではなく並び。
 *
 * AppSpec が表現しない型 (関連レコード一覧・ルックアップ) や飾り (ラベル・罫線) も
 * そのまま見せる。**扱えないものこそ、見えることに価値がある。**
 */

/** レイアウト上の 1 要素。フィールドのほか、ラベル・スペース・罫線が入る。 */
interface FormItem {
  readonly type?: string;
  readonly code?: string;
  readonly elementId?: string;
}

export interface DescribeFormOptions {
  /** 参照先アプリを併記するために使う。省略すると型だけを出す。 */
  readonly properties?: KintoneProperties;
}

export function describeForm(
  layout: readonly LayoutRow[],
  options: DescribeFormOptions = {},
): string[] {
  const width = String(layout.length).length;
  const lines: string[] = [];

  layout.forEach((row, index) => {
    const head = `${String(index + 1).padStart(width, " ")}: `;
    const indent = " ".repeat(head.length);

    if (row.type === "SUBTABLE") {
      lines.push(`${head}▦ ${nameOf(row)} (テーブル)`);
      lines.push(`${indent}  ${describeItems(itemsOf(row), options)}`);
      return;
    }
    if (row.type === "GROUP") {
      lines.push(`${head}▼ ${nameOf(row)} (グループ)`);
      for (const nested of (row as { layout?: LayoutRow[] }).layout ?? []) {
        lines.push(`${indent}  ${describeItems(itemsOf(nested), options)}`);
      }
      return;
    }
    lines.push(`${head}${describeItems(itemsOf(row), options)}`);
  });

  return lines;
}

function nameOf(row: LayoutRow): string {
  return (row as { code?: string }).code ?? row.type;
}

function itemsOf(row: LayoutRow): FormItem[] {
  const fields = (row as { fields?: FormItem[] }).fields;
  return Array.isArray(fields) ? fields : [];
}

function describeItems(items: readonly FormItem[], options: DescribeFormOptions): string {
  if (items.length === 0) return "(空)";
  return items.map((item) => describeItem(item, options)).join(" | ");
}

function describeItem(item: FormItem, options: DescribeFormOptions): string {
  const type = item.type ?? "?";
  // ラベル・スペース・罫線はフィールドではないので code を持たない。
  if (item.code === undefined) return `<${type}>`;

  const related = relatedAppOf(options.properties?.[item.code]);
  return `${item.code} (${type})${related === undefined ? "" : ` → アプリ ${related}`}`;
}

/**
 * 参照先のアプリ。
 *
 * ルックアップと関連レコード一覧は AppSpec で扱わないが、
 * 「どのアプリを見ているか」はフォームを読むうえで欠かせない。
 */
function relatedAppOf(property: Record<string, unknown> | undefined): string | undefined {
  if (property === undefined) return undefined;
  for (const key of ["referenceTable", "lookup"]) {
    const setting = property[key] as { relatedApp?: { app?: string; code?: string } } | undefined;
    const related = setting?.relatedApp;
    if (related === undefined) continue;
    // アプリコードが設定されていれば、そちらのほうが人には分かりやすい。
    if (related.code !== undefined && related.code !== "") return related.code;
    if (related.app !== undefined && related.app !== "") return related.app;
  }
  return undefined;
}
