import { describe, expect, it } from "vitest";
import {
  buildUpdatedLayout,
  collectLayoutFields,
  ORPHAN_GROUP_CODE,
  type LayoutField,
  type LayoutRow,
} from "../src/spec/layout.js";

/**
 * 更新後のレイアウト組み立て。
 *
 * レイアウト変更 API は「フォーム上のすべてのフィールド」の指定を求めるので、
 * 1 つでも落とすと失敗する。退避と復帰で取りこぼさないことが最重要。
 */

const field = (code: string, type = "SINGLE_LINE_TEXT"): LayoutField => ({ code, type });
const row = (...codes: string[]): LayoutRow => ({
  type: "ROW",
  fields: codes.map((code) => field(code)),
});
const orphanGroup = (...codes: string[]): LayoutRow => ({
  type: "GROUP",
  code: ORPHAN_GROUP_CODE,
  layout: codes.map((code) => row(code)),
});

/** 組み上がったレイアウトを「行ごとのコード」に均して比べやすくする。 */
function shape(layout: readonly LayoutRow[]): unknown[] {
  return layout.map((entry) => {
    if (entry.type === "ROW") {
      return (entry as { fields: LayoutField[] }).fields.map((f) => f.code);
    }
    return {
      group: (entry as unknown as { code: string }).code,
      layout: shape(((entry as { layout?: LayoutRow[] }).layout ?? []) as LayoutRow[]),
    };
  });
}

describe("削除候補への退避", () => {
  it("目標から消えたフィールドを、畳んだグループへ移す", () => {
    const layout = buildUpdatedLayout({
      current: [row("a"), row("b"), row("c")],
      desired: [field("a"), field("c")],
      orphans: ["b"],
      regroup: false,
    });

    expect(shape(layout)).toEqual([
      ["a"],
      ["c"],
      { group: ORPHAN_GROUP_CODE, layout: [["b"]] },
    ]);
  });

  it("退避してもフィールドは 1 つも失われない", () => {
    // ここが崩れるとレイアウト変更 API が失敗する。
    const current = [row("a", "b"), row("c"), row("d")];
    const layout = buildUpdatedLayout({
      current,
      desired: [field("a"), field("c")],
      orphans: ["b", "d"],
      regroup: false,
    });

    expect(collectLayoutFields(layout).map((f) => f.code).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("退避したフィールドの型を保つ", () => {
    const layout = buildUpdatedLayout({
      current: [{ type: "ROW", fields: [field("memo", "MULTI_LINE_TEXT")] }],
      desired: [],
      orphans: ["memo"],
      regroup: false,
    });
    const parked = collectLayoutFields(layout)[0]!;
    expect(parked).toEqual({ code: "memo", type: "MULTI_LINE_TEXT" });
  });

  it("退避が無ければグループを作らない", () => {
    const layout = buildUpdatedLayout({
      current: [row("a")],
      desired: [field("a")],
      orphans: [],
      regroup: false,
    });
    expect(layout.every((entry) => entry.type !== "GROUP")).toBe(true);
  });

  it("空になった行は残さない", () => {
    const layout = buildUpdatedLayout({
      current: [row("a"), row("b")],
      desired: [field("a")],
      orphans: ["b"],
      regroup: false,
    });
    expect(shape(layout)).toEqual([["a"], { group: ORPHAN_GROUP_CODE, layout: [["b"]] }]);
  });
});

describe("既にある削除候補グループ", () => {
  it("グループを増やさず、まとめて入れ直す", () => {
    // 毎回同じフィールドコードを使うので、更新を繰り返してもグループは 1 つ。
    // 先に退避してあったものも、退避したまま入れ直す。orphans には
    // 「今回あらたに退避するもの」しか来ないので、ここで拾わないと
    // レイアウトから消えてしまう (レイアウト変更 API が失敗する)。
    const layout = buildUpdatedLayout({
      current: [row("a"), orphanGroup("old")],
      desired: [field("a")],
      orphans: ["b"],
      regroup: false,
    });

    const groups = layout.filter((entry) => entry.type === "GROUP");
    expect(groups).toHaveLength(1);
    expect(shape(layout)).toEqual([
      ["a"],
      { group: ORPHAN_GROUP_CODE, layout: [["old"], ["b"]] },
    ]);
  });

  it("退避済みのフィールドを、並び替えのときにも落とさない", () => {
    // regroup で組み直すときは desired から作り直すので、
    // desired に居ない退避済みフィールドを見失いやすい。
    const layout = buildUpdatedLayout({
      current: [row("a"), orphanGroup("old")],
      desired: [field("a")],
      orphans: [],
      regroup: true,
    });

    expect(collectLayoutFields(layout).map((f) => f.code).sort()).toEqual(["a", "old"]);
    expect(shape(layout)).toEqual([["a"], { group: ORPHAN_GROUP_CODE, layout: [["old"]] }]);
  });

  it("目標に戻ってきたフィールドは、グループから出す", () => {
    const layout = buildUpdatedLayout({
      current: [row("a"), orphanGroup("b")],
      desired: [field("a"), field("b")],
      orphans: [],
      regroup: false,
    });

    expect(shape(layout)).toEqual([["a"], ["b"]]);
    expect(layout.every((entry) => entry.type !== "GROUP")).toBe(true);
  });

  it("戻すものと退避するものが同時にあっても取りこぼさない", () => {
    const layout = buildUpdatedLayout({
      current: [row("a"), row("b"), orphanGroup("c")],
      desired: [field("a"), field("c")],
      orphans: ["b"],
      regroup: false,
    });

    expect(collectLayoutFields(layout).map((f) => f.code).sort()).toEqual(["a", "b", "c"]);
    expect(shape(layout)).toEqual([
      ["a"],
      ["c"],
      { group: ORPHAN_GROUP_CODE, layout: [["b"]] },
    ]);
  });
});

describe("並びの組み直し", () => {
  it("regroup なら目標の並びで作り直す", () => {
    const layout = buildUpdatedLayout({
      current: [row("c"), row("a"), row("b")],
      desired: [field("a"), field("b"), field("c")],
      orphans: [],
      regroup: true,
      maxPerRow: 2,
    });
    expect(shape(layout)).toEqual([["a", "b"], ["c"]]);
  });

  it("regroup でなければ既存の行に手を触れない", () => {
    const layout = buildUpdatedLayout({
      current: [row("c", "a"), row("b")],
      desired: [field("a"), field("b"), field("c")],
      orphans: [],
      regroup: false,
    });
    expect(shape(layout)).toEqual([["c", "a"], ["b"]]);
  });

  it("組み直しても、退避したものはグループに入る", () => {
    const layout = buildUpdatedLayout({
      current: [row("a"), row("b"), row("c")],
      desired: [field("a"), field("b"), field("c")],
      orphans: ["c"],
      regroup: true,
      maxPerRow: 3,
    });
    expect(shape(layout)).toEqual([["a", "b"], { group: ORPHAN_GROUP_CODE, layout: [["c"]] }]);
  });

  it("組み直しでも SUBTABLE は残す", () => {
    const subtable: LayoutRow = { type: "SUBTABLE", code: "明細", fields: [] };
    const layout = buildUpdatedLayout({
      current: [row("a"), subtable],
      desired: [field("a")],
      orphans: [],
      regroup: true,
    });
    expect(layout.some((entry) => entry.type === "SUBTABLE")).toBe(true);
  });

  it("group の指定に従って横に並べる", () => {
    const layout = buildUpdatedLayout({
      current: [row("a"), row("b")],
      desired: [field("a"), field("b", "NUMBER")],
      orphans: [],
      regroup: true,
      groups: { a: "書誌", b: "書誌" },
    });
    // 型が違っても同じ group なら 1 行になる。
    expect(shape(layout)).toEqual([["a", "b"]]);
  });
});

/**
 * AppSpec に現れない要素。
 *
 * 組み直しは desired を起点にするので、そこに居ないものは何もしないと消える。
 * フィールドなら「レイアウトに指定が足りない」で更新ごと失敗し、
 * 飾り (ラベル・スペース・罫線) は API が求めないぶん黙って消える。
 */
describe("AppSpec に現れない要素を捨てない", () => {
  const reference = (code: string): LayoutRow => ({
    type: "ROW",
    fields: [{ code, type: "REFERENCE_TABLE" }],
  });
  const label = (elementId: string): LayoutRow => ({
    type: "ROW",
    fields: [{ type: "LABEL", label: "■", elementId } as unknown as LayoutField],
  });

  it("関連レコード一覧を残す", () => {
    const layout = buildUpdatedLayout({
      current: [row("倉庫コード"), reference("倉庫情報"), row("商品名")],
      desired: [field("倉庫コード"), field("商品名")],
      orphans: [],
      regroup: true,
    });

    expect(collectLayoutFields(layout).map((f) => f.code)).toContain("倉庫情報");
  });

  it("直前のフィールドの位置に戻す", () => {
    // 末尾に寄せると、link で置いた位置が update のたびに崩れる。
    const layout = buildUpdatedLayout({
      current: [row("倉庫コード"), reference("倉庫情報"), row("商品名")],
      desired: [field("倉庫コード"), field("商品名")],
      orphans: [],
      // 横並びを止めて、位置が分かる形で見る。
      regroup: true,
      maxPerRow: 1,
    });

    expect(shape(layout)).toEqual([["倉庫コード"], ["倉庫情報"], ["商品名"]]);
  });

  it("ラベルや罫線 (code を持たない飾り) も残す", () => {
    const layout = buildUpdatedLayout({
      current: [row("件名"), label("l1")],
      desired: [field("件名")],
      orphans: [],
      regroup: true,
    });

    const kinds = layout.flatMap((r) =>
      ((r as { fields?: { type: string }[] }).fields ?? []).map((f) => f.type),
    );
    expect(kinds).toContain("LABEL");
  });

  it("手掛かりのフィールドごと消えても捨てない", () => {
    // 直前のフィールドを削除候補へ送った場合。位置は諦めても、残す。
    const layout = buildUpdatedLayout({
      current: [row("倉庫コード"), reference("倉庫情報")],
      desired: [field("商品名")],
      orphans: ["倉庫コード"],
      regroup: true,
    });

    expect(collectLayoutFields(layout).map((f) => f.code)).toContain("倉庫情報");
  });

  it("セクションでも残す", () => {
    const layout = buildUpdatedLayout({
      current: [row("書名"), reference("貸出履歴")],
      desired: [field("書名")],
      orphans: [],
      regroup: true,
      sections: true,
      groups: { 書名: "書誌情報" },
    });

    expect(shape(layout)).toEqual([
      { group: "書誌情報", layout: [["書名"]] },
      ["貸出履歴"],
    ]);
  });
});
