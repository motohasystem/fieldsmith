import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KintoneConfig } from "../src/config.js";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import { deployAppSpec, UnsupportedUpdateError, updateApp } from "../src/kintone/deploy.js";
import { REQUIRED_SCOPE } from "../src/kintone/oauth.js";
import { saveToken } from "../src/kintone/tokenStore.js";
import { AppSpecValidationError, parseAppSpec } from "../src/spec/appSpec.js";
import { diffAppSpec } from "../src/spec/diff.js";
import { toAppSpecFromKintone } from "../src/spec/fromKintone.js";
import {
  buildFormRows,
  buildUpdatedLayout,
  collectLayoutFields,
  regroupLayout,
  tableCodeOf,
  type LayoutField,
  type LayoutRow,
} from "../src/spec/layout.js";
import { toFieldProperties } from "../src/spec/toKintone.js";
import { BASE_URL, noSleep, setupKintoneMock } from "./kintoneMock.js";

/**
 * テーブル。
 *
 * AppSpec では入れ子にせず、フィールドに `table` を付けて表す (`group` と同じ手)。
 * kintone のテーブルには**列の退避先が無い**ので、update では触らない。
 */

const field = (code: string, type = "SINGLE_LINE_TEXT"): LayoutField => ({ code, type });

const shape = (layout: readonly LayoutRow[]): unknown[] =>
  layout.map((row) =>
    row.type === "ROW"
      ? (row as { fields: LayoutField[] }).fields.map((f) => f.code)
      : row.type === "SUBTABLE"
        ? {
            table: (row as { code?: string }).code,
            fields: ((row as { fields?: LayoutField[] }).fields ?? []).map((f) => f.code),
          }
        : {
            group: (row as { code?: string }).code,
            layout: shape(((row as { layout?: LayoutRow[] }).layout ?? []) as LayoutRow[]),
          },
  );

describe("レイアウトの組み立て", () => {
  it("同じ table のフィールドが 1 つのテーブルになる", () => {
    const layout = buildFormRows([field("日付", "DATE"), field("品名"), field("金額", "NUMBER")], {
      tables: { 品名: "明細", 金額: "明細" },
    });

    expect(shape(layout)).toEqual([["日付"], { table: "明細", fields: ["品名", "金額"] }]);
  });

  it("テーブルの列は横並びの対象にしない (行の概念が無いため)", () => {
    // kintone のレイアウトで SUBTABLE が layout ではなく fields を持つのに合わせる。
    const codes = ["a", "b", "c", "d"];
    const layout = buildFormRows(
      codes.map((code) => field(code)),
      { tables: Object.fromEntries(codes.map((c) => [c, "明細"])), maxPerRow: 3 },
    );

    expect(shape(layout)).toEqual([{ table: "明細", fields: ["a", "b", "c", "d"] }]);
  });

  it("テーブルは書かれた位置に置く", () => {
    const layout = buildFormRows([field("品名"), field("備考")], { tables: { 品名: "明細" } });
    expect(shape(layout)).toEqual([{ table: "明細", fields: ["品名"] }, ["備考"]]);
  });

  it("テーブルとセクションが並んでも取り違えない", () => {
    const layout = buildFormRows([field("書名"), field("品名"), field("金額", "NUMBER")], {
      sections: true,
      groups: { 書名: "書誌情報" },
      tables: { 品名: "明細", 金額: "明細" },
    });

    expect(shape(layout)).toEqual([
      { group: "書誌情報", layout: [["書名"]] },
      { table: "明細", fields: ["品名", "金額"] },
    ]);
  });

  it("table の名前からフィールドコードが決まる (毎回同じ)", () => {
    expect(tableCodeOf("明細")).toBe("明細");
    expect(tableCodeOf("明細 (内訳)")).toBe(tableCodeOf("明細 (内訳)"));
  });
});

describe("知らないテーブルには触らない", () => {
  const subtable: LayoutRow = {
    type: "SUBTABLE",
    code: "明細",
    fields: [field("品名"), field("金額", "NUMBER")],
  };

  it("tables に無いテーブルは、そのまま残す", () => {
    // 解いてしまうと列が素の行に出て、レイアウト変更 API に弾かれる。
    const result = regroupLayout([{ type: "ROW", fields: [field("件名")] }, subtable], {});

    expect(shape(result)).toEqual([["件名"], { table: "明細", fields: ["品名", "金額"] }]);
    expect(result[1]).toBe(subtable);
  });

  it("tables に在るテーブルは、位置ごと組み直す", () => {
    const result = regroupLayout([subtable, { type: "ROW", fields: [field("件名")] }], {
      tables: { 品名: "明細", 金額: "明細" },
    });

    expect(shape(result)).toEqual([{ table: "明細", fields: ["品名", "金額"] }, ["件名"]]);
  });

  it("列を数え落とさない", () => {
    // レイアウト変更 API はフォーム上のすべてのフィールドを求める。
    expect(collectLayoutFields([subtable]).map((f) => f.code)).toEqual(["品名", "金額"]);
  });

  it("組み直しでもテーブルの列は失われない", () => {
    const layout = buildUpdatedLayout({
      current: [{ type: "ROW", fields: [field("件名")] }, subtable],
      desired: [field("件名"), field("品名"), field("金額", "NUMBER")],
      orphans: [],
      regroup: true,
      tables: { 品名: "明細", 金額: "明細" },
    });

    expect(collectLayoutFields(layout).map((f) => f.code).sort()).toEqual([
      "件名",
      "品名",
      "金額",
    ]);
    expect(shape(layout)).toEqual([["件名"], { table: "明細", fields: ["品名", "金額"] }]);
  });
});

describe("検証", () => {
  const issuesOf = (input: unknown): string[] => {
    try {
      parseAppSpec(input);
    } catch (error) {
      return (error as AppSpecValidationError).issues.map((issue) => issue.message);
    }
    return [];
  };
  const spec = (fields: unknown[], extra: Record<string, unknown> = {}) => ({
    name: "受注",
    fields,
    ...extra,
  });
  const text = (label: string, over: Record<string, unknown> = {}) => ({
    type: "SINGLE_LINE_TEXT",
    label,
    ...over,
  });

  it("問題が無ければ通る", () => {
    expect(
      issuesOf(spec([text("件名"), text("品名", { table: "明細" }), text("数量", { table: "明細" })])),
    ).toEqual([]);
  });

  it("同じ table が離れて書かれていたら弾く", () => {
    const issues = issuesOf(
      spec([text("品名", { table: "明細" }), text("件名"), text("数量", { table: "明細" })]),
    );
    expect(issues.join("\n")).toMatch(/table "明細" のフィールドが離れて書かれています/);
  });

  it("table と group は同時に指定できない", () => {
    // kintone はテーブルの中にグループを置けない。
    const issues = issuesOf(spec([text("品名", { table: "明細", group: "内訳" })]));
    expect(issues.join("\n")).toMatch(/同時に指定できません/);
  });

  it("フィールドコードと衝突する table を弾く", () => {
    const issues = issuesOf(spec([text("明細"), text("品名", { table: "明細" })]));
    expect(issues.join("\n")).toMatch(/フィールドコード "明細" と重複します/);
  });

  it("別々の table が同じコードになる場合を弾く", () => {
    const issues = issuesOf(
      spec([text("品名", { table: "明細 (内訳)" }), text("数量", { table: "明細_内訳" })]),
    );
    expect(issues.join("\n")).toMatch(/同じテーブルのフィールドコード/);
  });

  it("テーブルの列は一覧に指定できない", () => {
    // 1 レコードに複数の値を持つので、一覧の 1 列には収まらない。
    const issues = issuesOf(
      spec([text("件名"), text("品名", { table: "明細" })], {
        views: [{ name: "全件", fields: ["件名", "品名"] }],
      }),
    );
    expect(issues.join("\n")).toMatch(/テーブル「明細」の列なので、一覧には指定できません/);
  });
});

describe("kintone の properties への変換", () => {
  it("列を入れ子に収め、テーブルは最初の列の位置に作る", () => {
    const spec = parseAppSpec({
      name: "受注",
      fields: [
        { type: "SINGLE_LINE_TEXT", label: "件名" },
        { type: "SINGLE_LINE_TEXT", label: "品名", table: "明細" },
        { type: "NUMBER", label: "数量", table: "明細" },
      ],
    });
    const properties = toFieldProperties(spec.fields);

    expect(Object.keys(properties)).toEqual(["件名", "明細"]);
    expect(properties["明細"]).toEqual({
      type: "SUBTABLE",
      code: "明細",
      label: "明細",
      fields: {
        品名: { type: "SINGLE_LINE_TEXT", code: "品名", label: "品名" },
        数量: { type: "NUMBER", code: "数量", label: "数量" },
      },
    });
  });

  it("table は kintone に送らない (fieldsmith の中だけの情報)", () => {
    const spec = parseAppSpec({
      name: "受注",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "品名", table: "明細" }],
    });
    const column = (toFieldProperties(spec.fields)["明細"]!["fields"] as Record<string, unknown>)[
      "品名"
    ];
    expect(column).not.toHaveProperty("table");
  });
});

describe("pull がテーブルを読む", () => {
  const properties = {
    件名: { type: "SINGLE_LINE_TEXT", code: "件名", label: "件名" },
    明細: {
      type: "SUBTABLE",
      code: "明細",
      label: "明細",
      fields: {
        品名: { type: "SINGLE_LINE_TEXT", code: "品名", label: "品名" },
        数量: { type: "NUMBER", code: "数量", label: "数量" },
      },
    },
  };
  const layout = [
    { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "件名" }] },
    {
      type: "SUBTABLE",
      code: "明細",
      fields: [
        { type: "SINGLE_LINE_TEXT", code: "品名" },
        { type: "NUMBER", code: "数量" },
      ],
    },
  ];

  it("列を平らにして table で結ぶ", () => {
    const { spec, warnings } = toAppSpecFromKintone({ name: "受注", properties, layout });

    expect(spec["fields"]).toEqual([
      { type: "SINGLE_LINE_TEXT", code: "件名", label: "件名" },
      { type: "SINGLE_LINE_TEXT", code: "品名", label: "品名", table: "明細" },
      { type: "NUMBER", code: "数量", label: "数量", table: "明細" },
    ]);
    // 表現できているので警告しない。
    expect(warnings).toEqual([]);
  });

  it("往復してもテーブルの形が変わらない", () => {
    const { spec } = toAppSpecFromKintone({ name: "受注", properties, layout });
    const properties2 = toFieldProperties(parseAppSpec(spec).fields);

    expect(properties2["明細"]).toMatchObject({ type: "SUBTABLE", code: "明細", label: "明細" });
    expect(Object.keys(properties2["明細"]!["fields"] as object)).toEqual(["品名", "数量"]);
  });

  it("表現できない列は、その列だけ警告に残す", () => {
    const { spec, warnings } = toAppSpecFromKintone({
      name: "受注",
      properties: {
        明細: {
          type: "SUBTABLE",
          code: "明細",
          label: "明細",
          fields: {
            品名: { type: "SINGLE_LINE_TEXT", code: "品名", label: "品名" },
            参照: { type: "REFERENCE_TABLE", code: "参照", label: "参照" },
          },
        },
      },
      layout: [],
    });

    expect(spec["fields"]).toHaveLength(1);
    expect(warnings.join()).toMatch(/参照.*REFERENCE_TABLE/);
  });
});

describe("update はテーブルに触らない", () => {
  const spec = (fields: unknown[]) => parseAppSpec({ name: "受注", layout: "stacked", fields });
  const col = (label: string, table = "明細") => ({
    type: "SINGLE_LINE_TEXT",
    label,
    code: label,
    table,
  });
  const plain = (label: string) => ({ type: "SINGLE_LINE_TEXT", label, code: label });

  it("列を足そうとしたら差分に出る", () => {
    const diff = diffAppSpec(spec([plain("件名"), col("品名")]), spec([plain("件名"), col("品名"), col("数量")]));
    expect(diff.tableChanges).toEqual([{ code: "数量", table: "明細", kind: "added" }]);
  });

  it("列を外そうとしたら差分に出る", () => {
    const diff = diffAppSpec(spec([plain("件名"), col("品名")]), spec([plain("件名")]));
    expect(diff.tableChanges).toEqual([{ code: "品名", table: "明細", kind: "removed" }]);
  });

  it("フィールドをテーブルへ入れようとしたら差分に出る", () => {
    // kintone では作り直しになり、データが引き継がれない。
    const diff = diffAppSpec(spec([plain("品名")]), spec([col("品名")]));
    expect(diff.tableChanges).toEqual([{ code: "品名", table: "明細", kind: "moved" }]);
  });

  it("テーブルが変わっていなければ差分に出さない", () => {
    const diff = diffAppSpec(spec([plain("件名"), col("品名")]), spec([plain("件名"), col("品名")]));
    expect(diff.tableChanges).toEqual([]);
  });
});

/* ------------------------------ kintone との往復 ------------------------------ */

const config: KintoneConfig = {
  baseUrl: BASE_URL,
  auth: {
    kind: "oauth",
    clientId: "c",
    clientSecret: "s",
    redirectUri: "https://app.example.com/cb",
    authorizationEndpoint: `${BASE_URL}/oauth2/authorization`,
    tokenEndpoint: `${BASE_URL}/oauth2/token`,
  },
};

function withToken(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    FIELDSMITH_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fieldsmith-tbl-")),
  };
  saveToken(
    BASE_URL,
    { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scope: REQUIRED_SCOPE },
    env,
  );
  return env;
}

const polling = { initialDelayMs: 0, maxDelayMs: 0, sleep: noSleep };

describe("deploy がテーブルを作る", () => {
  it("SUBTABLE を送り、レイアウトにも入れ子で置く", async () => {
    const { server, mock } = setupKintoneMock({
      layout: [
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "件名" }] },
        {
          type: "SUBTABLE",
          code: "明細",
          fields: [
            { type: "SINGLE_LINE_TEXT", code: "品名" },
            { type: "NUMBER", code: "数量" },
          ],
        },
      ],
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    try {
      await deployAppSpec(
        parseAppSpec({
          name: "受注",
          fields: [
            { type: "SINGLE_LINE_TEXT", label: "件名" },
            { type: "SINGLE_LINE_TEXT", label: "品名", table: "明細" },
            { type: "NUMBER", label: "数量", table: "明細" },
          ],
        }),
        createAuthenticatedKintone({ config, env }),
        { polling },
      );
    } finally {
      server.close();
      rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
    }

    const properties = mock.callsTo("fields")[0]!.body["properties"] as Record<string, { type: string }>;
    expect(properties["明細"]!.type).toBe("SUBTABLE");

    const sent = mock.callsTo("updateLayout")[0]!.body["layout"] as LayoutRow[];
    expect(shape(sent)).toEqual([["件名"], { table: "明細", fields: ["品名", "数量"] }]);
  });
});

describe("update はテーブルの変更を拒む", () => {
  it("列を足そうとしたら、1 リクエストも投げずに止める", async () => {
    const { server, mock } = setupKintoneMock({
      existing: {
        settings: { name: "受注" },
        properties: {
          明細: {
            type: "SUBTABLE",
            code: "明細",
            label: "明細",
            fields: { 品名: { type: "SINGLE_LINE_TEXT", code: "品名", label: "品名" } },
          },
        },
      },
      layout: [
        { type: "SUBTABLE", code: "明細", fields: [{ type: "SINGLE_LINE_TEXT", code: "品名" }] },
      ],
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const error = await updateApp(
      "761",
      parseAppSpec({
        name: "受注",
        layout: "stacked",
        fields: [
          { type: "SINGLE_LINE_TEXT", label: "品名", code: "品名", table: "明細" },
          { type: "NUMBER", label: "数量", code: "数量", table: "明細" },
        ],
      }),
      createAuthenticatedKintone({ config, env }),
      { polling },
    )
      .then(() => null)
      .catch((e: unknown) => e as Error);

    server.close();
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });

    expect(error).toBeInstanceOf(UnsupportedUpdateError);
    expect(error!.message).toMatch(/テーブルの変更は update では反映できません/);
    // 読み取りだけで止まっている。
    expect(mock.callsTo("fields")).toHaveLength(0);
    expect(mock.callsTo("updateLayout")).toHaveLength(0);
  });
});
