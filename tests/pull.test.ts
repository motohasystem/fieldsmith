import { describe, expect, it } from "vitest";
import { parseAppSpec } from "../src/spec/appSpec.js";
import { toAppSpecFromKintone, type PullInput } from "../src/spec/fromKintone.js";
import { toKintonePayloads } from "../src/spec/toKintone.js";

/**
 * 既存アプリを AppSpec に戻す変換。
 *
 * 一番大事なのは「取得した spec がそのままデプロイできること」と
 * 「表現できなかったものを黙って捨てないこと」。
 */

const base = (over: Partial<PullInput> = {}): PullInput => ({
  name: "案件管理",
  properties: {},
  ...over,
});

describe("フィールドの復元", () => {
  it("kintone の表現から AppSpec の表現に戻す", () => {
    const { spec } = toAppSpecFromKintone(
      base({
        properties: {
          案件名: { type: "SINGLE_LINE_TEXT", code: "案件名", label: "案件名", required: true },
          金額: {
            type: "NUMBER",
            code: "金額",
            label: "金額",
            digit: true,
            unit: "円",
            unitPosition: "AFTER",
            // kintone は数値も文字列で返す。
            minValue: "0",
            maxValue: "",
          },
        },
      }),
    );

    expect(spec["fields"]).toEqual([
      { type: "SINGLE_LINE_TEXT", code: "案件名", label: "案件名", required: true },
      {
        type: "NUMBER",
        code: "金額",
        label: "金額",
        digit: true,
        unit: "円",
        unitPosition: "AFTER",
        minValue: "0",
      },
    ]);
  });

  it("選択肢を index の順に並べ直す (kintone はオブジェクトで返す)", () => {
    const { spec } = toAppSpecFromKintone(
      base({
        properties: {
          確度: {
            type: "DROP_DOWN",
            code: "確度",
            label: "確度",
            defaultValue: "中",
            options: {
              低: { label: "低", index: "2" },
              高: { label: "高", index: "0" },
              中: { label: "中", index: "1" },
            },
          },
        },
      }),
    );

    expect((spec["fields"] as Record<string, unknown>[])[0]).toEqual({
      type: "DROP_DOWN",
      code: "確度",
      label: "確度",
      options: ["高", "中", "低"],
      defaultValue: "中",
    });
  });

  it("レイアウトの並び順でフィールドを並べる", () => {
    const { spec } = toAppSpecFromKintone(
      base({
        properties: {
          c: { type: "SINGLE_LINE_TEXT", code: "c", label: "c" },
          a: { type: "SINGLE_LINE_TEXT", code: "a", label: "a" },
          b: { type: "SINGLE_LINE_TEXT", code: "b", label: "b" },
        },
        layout: [
          { type: "ROW", fields: [{ code: "a" }, { code: "b" }] },
          { type: "ROW", fields: [{ code: "c" }] },
        ],
      }),
    );

    expect((spec["fields"] as { code: string }[]).map((f) => f.code)).toEqual(["a", "b", "c"]);
  });

  it("グループやテーブルの中のフィールドも並び順に含める", () => {
    const { spec } = toAppSpecFromKintone(
      base({
        properties: {
          x: { type: "SINGLE_LINE_TEXT", code: "x", label: "x" },
          y: { type: "SINGLE_LINE_TEXT", code: "y", label: "y" },
        },
        layout: [
          { type: "GROUP", code: "g", layout: [{ type: "ROW", fields: [{ code: "y" }] }] },
          { type: "ROW", fields: [{ code: "x" }] },
        ],
      }),
    );
    expect((spec["fields"] as { code: string }[]).map((f) => f.code)).toEqual(["y", "x"]);
  });

  it("自動で用意されるフィールドは含めない", () => {
    const { spec, warnings } = toAppSpecFromKintone(
      base({
        properties: {
          レコード番号: { type: "RECORD_NUMBER", code: "レコード番号", label: "レコード番号" },
          作成者: { type: "CREATOR", code: "作成者", label: "作成者" },
          作業者: { type: "STATUS_ASSIGNEE", code: "作業者", label: "作業者" },
          案件名: { type: "SINGLE_LINE_TEXT", code: "案件名", label: "案件名" },
        },
      }),
    );

    expect(spec["fields"]).toHaveLength(1);
    // これらは「表現できない」のではなく「書く必要がない」ので警告しない。
    expect(warnings).toEqual([]);
  });
});

describe("表現できないものを黙って捨てない", () => {
  it("未対応のフィールド型は警告に残す", () => {
    const { spec, warnings } = toAppSpecFromKintone(
      base({
        properties: {
          明細: { type: "SUBTABLE", code: "明細", label: "明細" },
          参照: { type: "LOOKUP", code: "参照", label: "参照" },
          案件名: { type: "SINGLE_LINE_TEXT", code: "案件名", label: "案件名" },
        },
      }),
    );

    expect(spec["fields"]).toHaveLength(1);
    expect(warnings).toHaveLength(2);
    expect(warnings.join()).toMatch(/明細.*SUBTABLE/);
    expect(warnings.join()).toMatch(/作られません/);
  });

  it("未対応の一覧形式も警告に残す", () => {
    const { warnings } = toAppSpecFromKintone(
      base({
        views: {
          カスタム: { type: "CUSTOM", name: "カスタム", index: "0", html: "<div/>" },
          一覧: { type: "LIST", name: "一覧", index: "1" },
        },
      }),
    );
    expect(warnings.join()).toMatch(/カスタム.*CUSTOM/);
  });

  it("画像アイコンは戻せないことを知らせる", () => {
    const { warnings } = toAppSpecFromKintone(base({ icon: { type: "FILE" } }));
    expect(warnings.join()).toMatch(/アイコン/);
  });

  it("組込みアイコンでは警告しない (指定していないのと同じ)", () => {
    expect(toAppSpecFromKintone(base({ icon: { type: "PRESET" } })).warnings).toEqual([]);
  });

  it("レイアウトは再現しないので、既存の並びに手を触れない指定にする", () => {
    expect(toAppSpecFromKintone(base()).spec["layout"]).toBe("stacked");
  });
});

describe("アプリ設定の復元", () => {
  it("説明の HTML をテキストに均す", () => {
    const { spec } = toAppSpecFromKintone(base({ description: "案件を管理します" }));
    expect(spec["description"]).toBe("案件を管理します");
  });

  it("既定のままの設定は書かない", () => {
    const { spec } = toAppSpecFromKintone(
      base({ settings: { enableComments: false, firstMonthOfFiscalYear: "1" } }),
    );
    expect(spec).not.toHaveProperty("settings");
  });

  it("既定と違う設定だけを書く", () => {
    const { spec } = toAppSpecFromKintone(
      base({
        titleField: { selectionMode: "MANUAL", code: "案件名" },
        settings: { enableComments: true, firstMonthOfFiscalYear: "4" },
      }),
    );
    expect(spec["settings"]).toEqual({
      titleFieldCode: "案件名",
      enableComments: true,
      firstMonthOfFiscalYear: 4,
    });
  });

  it("タイトルが自動選択なら書かない", () => {
    const { spec } = toAppSpecFromKintone(
      base({ titleField: { selectionMode: "AUTO", code: "案件名" } }),
    );
    expect(spec).not.toHaveProperty("settings");
  });
});

describe("往復", () => {
  const original = parseAppSpec({
    name: "案件管理",
    description: "営業案件を管理します",
    theme: "BLUE",
    layout: "stacked",
    fields: [
      { type: "SINGLE_LINE_TEXT", label: "案件名", required: true },
      { type: "NUMBER", label: "金額", digit: true, unit: "円", unitPosition: "AFTER" },
      { type: "DROP_DOWN", label: "確度", options: ["高", "中", "低"], defaultValue: "中" },
      { type: "DATE", label: "受注予定日" },
      { type: "MULTI_LINE_TEXT", label: "備考" },
    ],
    views: [{ name: "全件", type: "LIST", fields: ["案件名", "金額"], sort: "案件名 asc" }],
    settings: { titleFieldCode: "案件名", enableComments: true },
  });

  /** deploy が送る内容から、kintone が返すであろう形を組み立てる。 */
  function asKintoneWouldReturn(): PullInput {
    const payloads = toKintonePayloads(original);
    return {
      name: payloads.appName,
      description: original.description,
      theme: original.theme,
      properties: payloads.properties as Record<string, Record<string, unknown>>,
      layout: original.fields.map((field) => ({
        type: "ROW",
        fields: [{ code: field.code ?? field.label }],
      })),
      views: payloads.views ?? undefined,
      titleField: { selectionMode: "MANUAL", code: "案件名" },
      settings: { enableComments: true },
    };
  }

  it("デプロイして取得し直すと、同じ AppSpec に戻る", () => {
    const { spec, warnings } = toAppSpecFromKintone(asKintoneWouldReturn());
    const restored = parseAppSpec(spec);

    expect(warnings).toEqual([]);
    // フィールドコードは復元時に明示されるので、そこだけ揃えて比べる。
    expect(restored.fields).toEqual(
      original.fields.map((field) => ({ ...field, code: field.code ?? field.label })),
    );
    expect(restored.name).toBe(original.name);
    expect(restored.description).toBe(original.description);
    expect(restored.theme).toBe(original.theme);
    expect(restored.settings).toEqual(original.settings);
  });

  it("復元した AppSpec は、そのまま kintone に送れる", () => {
    const { spec } = toAppSpecFromKintone(asKintoneWouldReturn());
    const restored = parseAppSpec(spec);
    // 同じペイロードになれば、複製しても同じアプリができる。
    expect(toKintonePayloads(restored).properties).toEqual(toKintonePayloads(original).properties);
  });
});
