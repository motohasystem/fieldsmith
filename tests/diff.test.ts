import { describe, expect, it } from "vitest";
import { parseAppSpec } from "../src/spec/appSpec.js";
import { describeDiff, diffAppSpec, isEmptyDiff } from "../src/spec/diff.js";

/**
 * 既存アプリと目標の AppSpec の差分。
 *
 * ここが間違うと、意図しないフィールドが削除候補に送られたり、
 * 変更が取りこぼされたりする。同一性はフィールドコードで決まる。
 */

const spec = (fields: unknown[], over: Record<string, unknown> = {}) =>
  parseAppSpec({ name: "案件管理", layout: "stacked", fields, ...over });

const text = (label: string, over: Record<string, unknown> = {}) => ({
  type: "SINGLE_LINE_TEXT",
  label,
  code: label,
  ...over,
});

describe("フィールドの差分", () => {
  it("目標にしか無いものは追加", () => {
    const diff = diffAppSpec(spec([text("案件名")]), spec([text("案件名"), text("顧客名")]));
    expect(diff.added.map((a) => a.code)).toEqual(["顧客名"]);
    expect(diff.orphaned).toEqual([]);
  });

  it("現状にしか無いものは削除候補 (消さない)", () => {
    const diff = diffAppSpec(spec([text("案件名"), text("顧客名")]), spec([text("案件名")]));
    expect(diff.orphaned).toEqual([
      { code: "顧客名", type: "SINGLE_LINE_TEXT", label: "顧客名" },
    ]);
    expect(diff.added).toEqual([]);
  });

  it("設定が変わったものは変更として、変化した項目だけを挙げる", () => {
    const diff = diffAppSpec(
      spec([text("案件名")]),
      spec([text("案件名", { required: true, maxLength: 64 })]),
    );
    expect(diff.updated).toHaveLength(1);
    expect(diff.updated[0]!.changes).toEqual([
      { key: "maxLength", from: undefined, to: 64 },
      { key: "required", from: undefined, to: true },
    ]);
  });

  it("選択肢の中身の変化を捉える", () => {
    const current = spec([{ type: "DROP_DOWN", label: "確度", code: "確度", options: ["高", "低"] }]);
    const desired = spec([
      { type: "DROP_DOWN", label: "確度", code: "確度", options: ["S", "A", "B"] },
    ]);
    const diff = diffAppSpec(current, desired);
    expect(diff.updated[0]!.changes).toEqual([
      { key: "options", from: ["高", "低"], to: ["S", "A", "B"] },
    ]);
  });

  it("選択肢の並びが同じなら変更にしない", () => {
    const one = spec([{ type: "DROP_DOWN", label: "確度", code: "確度", options: ["高", "低"] }]);
    expect(isEmptyDiff(diffAppSpec(one, one))).toBe(true);
  });

  it("型の変更は実行できないものとして分ける", () => {
    const diff = diffAppSpec(
      spec([text("備考")]),
      spec([{ type: "MULTI_LINE_TEXT", label: "備考", code: "備考" }]),
    );
    expect(diff.retyped).toEqual([
      { code: "備考", from: "SINGLE_LINE_TEXT", to: "MULTI_LINE_TEXT" },
    ]);
    // 型が違うものを「変更」に混ぜない (updateFormFields では実現できないため)。
    expect(diff.updated).toEqual([]);
  });

  it("同一性はコードで決まる。ラベルだけ変えても同じフィールド", () => {
    const diff = diffAppSpec(
      spec([text("案件名")]),
      spec([{ type: "SINGLE_LINE_TEXT", label: "案件タイトル", code: "案件名" }]),
    );
    expect(diff.added).toEqual([]);
    expect(diff.orphaned).toEqual([]);
    expect(diff.updated[0]!.changes).toEqual([
      { key: "label", from: "案件名", to: "案件タイトル" },
    ]);
  });

  it("コードが変わると別フィールドになる (追加 + 削除候補)", () => {
    // LLM に spec を書き直させるとき、既存のコードを保つよう指示が要る理由。
    const diff = diffAppSpec(
      spec([text("案件名")]),
      spec([{ type: "SINGLE_LINE_TEXT", label: "案件名", code: "title" }]),
    );
    expect(diff.added.map((a) => a.code)).toEqual(["title"]);
    expect(diff.orphaned.map((o) => o.code)).toEqual(["案件名"]);
  });

  it("group はレイアウトの都合なので、差分に数えない", () => {
    const diff = diffAppSpec(
      spec([text("案件名")]),
      spec([text("案件名", { group: "基本" })]),
    );
    expect(diff.updated).toEqual([]);
  });

  it("並べ替えても、追加や削除候補には数えない", () => {
    // 対応付けはコードで行うので、JSON 内の順序で誤判定しない。
    const diff = diffAppSpec(spec([text("a"), text("b")]), spec([text("b"), text("a")]));
    expect(diff.added).toEqual([]);
    expect(diff.orphaned).toEqual([]);
    expect(diff.updated).toEqual([]);
  });
});

describe("フォームの並びの差分", () => {
  const grouped = (fields: unknown[], over: Record<string, unknown> = {}) =>
    spec(fields, { layout: "grouped", ...over });

  it("並べ替えを差分として拾う", () => {
    // 拾わないと「並べ替えたのに差分なし」と言われ、update しても何も起きない。
    const diff = diffAppSpec(grouped([text("a"), text("b")]), grouped([text("b"), text("a")]));
    expect(diff.layout.orderChanged).toBe(true);
    expect(diff.layout.willApply).toBe(true);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(describeDiff(diff).join()).toMatch(/並びを組み直す.*並び順/);
  });

  it("group の変更を差分として拾う", () => {
    const diff = diffAppSpec(
      grouped([text("a", { group: "X" }), text("b", { group: "X" })]),
      grouped([text("a", { group: "Y" }), text("b", { group: "Z" })]),
    );
    expect(diff.layout.groupsChanged).toBe(true);
    expect(describeDiff(diff).join()).toMatch(/group/);
  });

  it("layout の指定の変更を差分として拾う", () => {
    const diff = diffAppSpec(spec([text("a")], { layout: "stacked" }), grouped([text("a")]));
    expect(diff.layout.modeChanged).toBe(true);
    expect(diff.layout.from).toBe("stacked");
    expect(diff.layout.to).toBe("grouped (最大 3 列)");
  });

  it("列数の変更も拾う", () => {
    const diff = diffAppSpec(
      grouped([text("a")]),
      spec([text("a")], { layout: { mode: "grouped", maxPerRow: 2 } }),
    );
    expect(diff.layout.modeChanged).toBe(true);
  });

  it("目標が stacked なら、並びの違いがあっても適用しない", () => {
    // stacked は「既存の並びに手を触れない」指定。何も起きないので差分に数えない。
    const diff = diffAppSpec(
      spec([text("a"), text("b")], { layout: "stacked" }),
      spec([text("b"), text("a")], { layout: "stacked" }),
    );
    expect(diff.layout.orderChanged).toBe(true);
    expect(diff.layout.willApply).toBe(false);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("追加・削除だけでは並べ替えたことにしない", () => {
    // 両方に在るフィールドの相対順序だけを見る。
    const diff = diffAppSpec(grouped([text("a"), text("b")]), grouped([text("a"), text("c"), text("b")]));
    expect(diff.layout.orderChanged).toBe(false);
  });

  it("変化が無ければ組み直さない", () => {
    const one = grouped([text("a", { group: "X" })]);
    expect(diffAppSpec(one, one).layout.willApply).toBe(false);
  });
});

describe("アプリ設定の差分", () => {
  it("名前・説明・テーマの変化を捉える", () => {
    const diff = diffAppSpec(
      spec([text("案件名")], { description: "旧", theme: "WHITE" }),
      spec([text("案件名")], { name: "案件管理", description: "新", theme: "BLUE" }),
    );
    expect(diff.app).toEqual([
      { key: "description", from: "旧", to: "新" },
      { key: "theme", from: "WHITE", to: "BLUE" },
    ]);
  });

  it("一般設定の変化を捉える", () => {
    const diff = diffAppSpec(
      spec([text("案件名")], { settings: { enableComments: true } }),
      spec([text("案件名")], { settings: { enableComments: false, titleFieldCode: "案件名" } }),
    );
    expect(diff.app).toEqual([
      { key: "settings.enableComments", from: true, to: false },
      { key: "settings.titleFieldCode", from: undefined, to: "案件名" },
    ]);
  });

  /**
   * kintone の設定変更 API は省略した項目を変えない。
   * 「書かれていない = 現状維持」にしないと、実際には何も起きないのに
   * 差分が永遠に消えないアプリができてしまう。
   */
  it("目標に書かれていない項目は現状維持として、差分にしない", () => {
    const diff = diffAppSpec(
      spec([text("案件名")], { theme: "WHITE", description: "説明", settings: { enableComments: true } }),
      spec([text("案件名")]),
    );
    expect(diff.app).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("フィールドでも、書かれていない項目は現状維持", () => {
    const diff = diffAppSpec(
      spec([text("案件名", { required: true, maxLength: 64 })]),
      spec([text("案件名")]),
    );
    expect(diff.updated).toEqual([]);
  });

  /**
   * kintone の真偽値の既定は false。分けて扱うと、
   * 「required を書いていない」と「required: false と書いた」が毎回差分になる。
   */
  it("真偽値の未指定と false を同じものとして扱う", () => {
    const diff = diffAppSpec(
      spec([text("案件名")]),
      spec([text("案件名", { required: false })]),
    );
    expect(diff.updated).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("true から false への変更は捉える", () => {
    const diff = diffAppSpec(
      spec([text("案件名", { required: true })]),
      spec([text("案件名", { required: false })]),
    );
    expect(diff.updated[0]!.changes).toEqual([{ key: "required", from: true, to: false }]);
  });

  it("明示的に書けば変えられる", () => {
    const diff = diffAppSpec(
      spec([text("案件名", { required: true })]),
      spec([text("案件名", { required: false })]),
    );
    expect(diff.updated[0]!.changes).toEqual([{ key: "required", from: true, to: false }]);
  });
});

describe("一覧の差分", () => {
  const withViews = (views: unknown[]) => spec([text("案件名")], { views });

  it("名前で対応付ける", () => {
    const diff = diffAppSpec(
      withViews([{ name: "全件", type: "LIST", fields: ["案件名"] }]),
      withViews([
        { name: "全件", type: "LIST", fields: ["案件名"], sort: "案件名 asc" },
        { name: "新規", type: "LIST" },
      ]),
    );
    expect(diff.views.added.map((v) => v.name)).toEqual(["新規"]);
    expect(diff.views.updated[0]!.changes.map((c) => c.key)).toEqual(["sort"]);
    expect(diff.views.removed).toEqual([]);
  });

  it("目標に無い一覧は削除として挙げる (フィールドと違い、消しても困らない)", () => {
    const diff = diffAppSpec(
      withViews([{ name: "全件", type: "LIST" }, { name: "旧", type: "LIST" }]),
      withViews([{ name: "全件", type: "LIST" }]),
    );
    expect(diff.views.removed).toEqual(["旧"]);
  });
});

describe("差分なし", () => {
  it("同じ AppSpec どうしなら空", () => {
    const one = spec([text("案件名", { required: true })], { description: "説明" });
    const diff = diffAppSpec(one, one);
    expect(isEmptyDiff(diff)).toBe(true);
    expect(describeDiff(diff)).toEqual([]);
  });
});

describe("差分の表示", () => {
  it("記号で種類が分かる", () => {
    const lines = describeDiff(
      diffAppSpec(
        spec([text("案件名"), text("顧客名")]),
        spec([text("案件名", { required: true }), text("受注日")]),
      ),
    );
    expect(lines.some((l) => l.startsWith("  + 受注日"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  ~ 案件名"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  - 顧客名"))).toBe(true);
  });

  it("型変更は実行できないことが分かる形で出す", () => {
    const lines = describeDiff(
      diffAppSpec(
        spec([text("備考")]),
        spec([{ type: "MULTI_LINE_TEXT", label: "備考", code: "備考" }]),
      ),
    );
    expect(lines[0]).toMatch(/^ {2}! 備考/);
    expect(lines[0]).toMatch(/kintone では不可/);
  });
});
