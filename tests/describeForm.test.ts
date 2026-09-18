import { describe, expect, it } from "vitest";
import { describeForm } from "../src/spec/describeForm.js";
import type { LayoutRow } from "../src/spec/layout.js";

/**
 * フォームの構造の表示。
 *
 * `pull` は AppSpec を吐くので、どれが同じ行に並んでいるかが見えない。
 * 「このフィールドの近くに何かを置きたい」ときに要るのは定義ではなく並び。
 */

const row = (...items: { type: string; code?: string }[]): LayoutRow => ({ type: "ROW", fields: items });

describe("フォームの構造を読む", () => {
  it("同じ行のフィールドを 1 行にまとめて出す", () => {
    expect(
      describeForm([
        row({ type: "DATE", code: "年月日" }, { type: "SINGLE_LINE_TEXT", code: "倉庫コード" }),
        row({ type: "SINGLE_LINE_TEXT", code: "備考" }),
      ]),
    ).toEqual(["1: 年月日 (DATE) | 倉庫コード (SINGLE_LINE_TEXT)", "2: 備考 (SINGLE_LINE_TEXT)"]);
  });

  it("テーブルとグループを見分けられる形で出す", () => {
    const layout: LayoutRow[] = [
      { type: "SUBTABLE", code: "明細", fields: [{ type: "NUMBER", code: "数量" }] },
      { type: "GROUP", code: "書誌情報", layout: [row({ type: "SINGLE_LINE_TEXT", code: "書名" })] },
    ];

    expect(describeForm(layout)).toEqual([
      "1: ▦ 明細 (テーブル)",
      "     数量 (NUMBER)",
      "2: ▼ 書誌情報 (グループ)",
      "     書名 (SINGLE_LINE_TEXT)",
    ]);
  });

  it("参照先のアプリを併記する", () => {
    // AppSpec では扱えない型だが、どのアプリを見ているかはフォームを読むうえで要る。
    const lines = describeForm([row({ type: "REFERENCE_TABLE", code: "倉庫情報" })], {
      properties: {
        倉庫情報: { type: "REFERENCE_TABLE", referenceTable: { relatedApp: { app: "774", code: "" } } },
      },
    });

    expect(lines).toEqual(["1: 倉庫情報 (REFERENCE_TABLE) → アプリ 774"]);
  });

  it("アプリコードがあればそちらを出す (人には分かりやすい)", () => {
    const lines = describeForm([row({ type: "SINGLE_LINE_TEXT", code: "本棚ID" })], {
      properties: {
        本棚ID: { type: "SINGLE_LINE_TEXT", lookup: { relatedApp: { app: "12", code: "HONDANA" } } },
      },
    });

    expect(lines[0]).toMatch(/→ アプリ HONDANA/);
  });

  it("ラベルや罫線も見せる (code を持たないので型で示す)", () => {
    expect(describeForm([row({ type: "LABEL" }, { type: "HR" })])).toEqual(["1: <LABEL> | <HR>"]);
  });

  it("行番号の桁を揃える", () => {
    const layout = Array.from({ length: 10 }, (_, i) => row({ type: "NUMBER", code: `f${i}` }));
    const lines = describeForm(layout);

    expect(lines[0]).toMatch(/^ 1: /);
    expect(lines[9]).toMatch(/^10: /);
  });
});
