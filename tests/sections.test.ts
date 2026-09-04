import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KintoneConfig } from "../src/config.js";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import { deployAppSpec, updateApp } from "../src/kintone/deploy.js";
import { REQUIRED_SCOPE } from "../src/kintone/oauth.js";
import { saveToken } from "../src/kintone/tokenStore.js";
import { AppSpecValidationError, parseAppSpec } from "../src/spec/appSpec.js";
import { diffAppSpec } from "../src/spec/diff.js";
import { toAppSpecFromKintone } from "../src/spec/fromKintone.js";
import {
  buildSectionedRows,
  buildUpdatedLayout,
  collectLayoutFields,
  describeLayout,
  ORPHAN_GROUP_CODE,
  sectionCodeOf,
  type LayoutField,
  type LayoutRow,
} from "../src/spec/layout.js";
import { BASE_URL, noSleep, setupKintoneMock } from "./kintoneMock.js";

/**
 * セクション (kintone のグループフィールド)。
 *
 * `group` は `grouped` では横並びのヒントでしかないが、`sections` では
 * 実際のグループフィールドになる。同じ `group` から**毎回同じフィールドコード**が
 * 出ることが要で、これが崩れると update のたびにグループが増える。
 */

const field = (code: string, type = "SINGLE_LINE_TEXT"): LayoutField => ({ code, type });

/** 組み上がったレイアウトを比べやすい形に均す。 */
const shape = (layout: readonly LayoutRow[]): unknown[] =>
  layout.map((row) =>
    row.type === "ROW"
      ? (row as { fields: LayoutField[] }).fields.map((f) => f.code)
      : {
          group: (row as { code?: string }).code,
          layout: shape(((row as { layout?: LayoutRow[] }).layout ?? []) as LayoutRow[]),
        },
  );

describe("セクションの組み立て", () => {
  it("同じ group のフィールドが 1 つのグループに入る", () => {
    const layout = buildSectionedRows([field("書名"), field("著者"), field("貸出日", "DATE")], {
      groups: { 書名: "書誌情報", 著者: "書誌情報", 貸出日: "貸出" },
    });

    expect(shape(layout)).toEqual([
      { group: "書誌情報", layout: [["書名", "著者"]] },
      { group: "貸出", layout: [["貸出日"]] },
    ]);
  });

  it("group の無いフィールドは素の行のまま置く", () => {
    const layout = buildSectionedRows([field("備考"), field("書名"), field("著者")], {
      groups: { 書名: "書誌情報", 著者: "書誌情報" },
    });

    expect(shape(layout)).toEqual([["備考"], { group: "書誌情報", layout: [["書名", "著者"]] }]);
  });

  it("セクションの中でも 1 行の上限を守る", () => {
    const codes = ["a", "b", "c", "d"];
    const layout = buildSectionedRows(
      codes.map((code) => field(code)),
      { groups: Object.fromEntries(codes.map((code) => [code, "まとまり"])), maxPerRow: 3 },
    );

    expect(shape(layout)).toEqual([{ group: "まとまり", layout: [["a", "b", "c"], ["d"]] }]);
  });

  it("幅を取る型はセクションの中でも単独行にする", () => {
    const layout = buildSectionedRows([field("書名"), field("あらすじ", "MULTI_LINE_TEXT")], {
      groups: { 書名: "書誌情報", あらすじ: "書誌情報" },
    });

    expect(shape(layout)).toEqual([{ group: "書誌情報", layout: [["書名"], ["あらすじ"]] }]);
  });

  it("group の名前からフィールドコードが決まる (毎回同じ)", () => {
    // ここがぶれると、更新のたびに新しいグループができてしまう。
    expect(sectionCodeOf("書誌情報")).toBe("書誌情報");
    expect(sectionCodeOf("貸出 (履歴)")).toBe(sectionCodeOf("貸出 (履歴)"));
    expect(sectionCodeOf("貸出 (履歴)")).not.toContain("(");
  });
});

describe("組み上がりの表示", () => {
  it("入れ子を字下げで示す (--dry-run で使う)", () => {
    const layout = buildSectionedRows([field("書名"), field("著者"), field("備考")], {
      groups: { 書名: "書誌情報", 著者: "書誌情報" },
    });

    expect(describeLayout(layout)).toEqual(["▼ 書誌情報", "    書名 | 著者", "備考"]);
  });
});

describe("セクションの検証", () => {
  const spec = (fields: unknown[], layout: unknown = "sections") => ({
    name: "蔵書管理",
    layout,
    fields,
  });
  const text = (label: string, group?: string) => ({
    type: "SINGLE_LINE_TEXT",
    label,
    ...(group === undefined ? {} : { group }),
  });

  const issuesOf = (input: unknown): string[] => {
    try {
      parseAppSpec(input);
    } catch (error) {
      return (error as AppSpecValidationError).issues.map((issue) => issue.message);
    }
    return [];
  };

  it("フィールドコードと衝突する group を弾く", () => {
    const issues = issuesOf(spec([text("分類"), text("書名", "分類")]));
    expect(issues.join("\n")).toMatch(/フィールドコード "分類" と重複/);
  });

  it("別々の group が同じコードになる場合を弾く", () => {
    // "貸出 (中)" と "貸出_中" はどちらも "貸出_中" になる。
    const issues = issuesOf(spec([text("a", "貸出 (中)"), text("b", "貸出_中")]));
    expect(issues.join("\n")).toMatch(/同じグループのフィールドコード/);
  });

  it("どんな group を書いても、退避先とは衝突しない", () => {
    // 削除候補グループのコードは先頭が `_` で、deriveFieldCode はそれを落とす。
    // この不変条件が崩れると、利用者のセクションが退避先を乗っ取れてしまう。
    for (const name of ["_削除候補", "削除候補", "__削除候補__"]) {
      expect(sectionCodeOf(name)).not.toBe(ORPHAN_GROUP_CODE);
    }
    expect(issuesOf(spec([text("書名", "_削除候補")]))).toEqual([]);
  });

  it("grouped では group はレイアウトのヒントなので、コードの衝突を見ない", () => {
    // sections でだけ効く検証であることを固定する。
    expect(issuesOf(spec([text("分類"), text("書名", "分類")], "grouped"))).toEqual([]);
  });

  it("問題が無ければ通る", () => {
    expect(issuesOf(spec([text("書名", "書誌情報"), text("著者", "書誌情報")]))).toEqual([]);
  });
});

describe("pull がグループを読む", () => {
  const properties = {
    書名: { type: "SINGLE_LINE_TEXT", code: "書名", label: "書名" },
    著者: { type: "SINGLE_LINE_TEXT", code: "著者", label: "著者" },
    書誌情報: { type: "GROUP", code: "書誌情報", label: "書誌情報", openGroup: true },
    備考: { type: "SINGLE_LINE_TEXT", code: "備考", label: "備考" },
  };
  const layout = [
    {
      type: "GROUP",
      code: "書誌情報",
      layout: [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "書名" }, { type: "SINGLE_LINE_TEXT", code: "著者" }] }],
    },
    { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "備考" }] },
  ];

  it("group を復元し、sections と名乗る", () => {
    const { spec, warnings } = toAppSpecFromKintone({ name: "蔵書", properties, layout });

    expect(spec["layout"]).toBe("sections");
    expect(spec["fields"]).toEqual([
      { type: "SINGLE_LINE_TEXT", code: "書名", label: "書名", group: "書誌情報" },
      { type: "SINGLE_LINE_TEXT", code: "著者", label: "著者", group: "書誌情報" },
      { type: "SINGLE_LINE_TEXT", code: "備考", label: "備考" },
    ]);
    // グループはフィールドとして書き出さないが、落としたわけではないので警告しない。
    expect(warnings).toEqual([]);
  });

  it("グループが無ければ stacked のまま (横並びは読み取れない)", () => {
    const { spec } = toAppSpecFromKintone({
      name: "蔵書",
      properties: { 書名: properties.書名 },
      layout: [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "書名" }] }],
    });

    expect(spec["layout"]).toBe("stacked");
  });

  it("削除候補グループはセクションとして扱わない", () => {
    const { spec, warnings } = toAppSpecFromKintone({
      name: "蔵書",
      properties: {
        書名: properties.書名,
        [ORPHAN_GROUP_CODE]: { type: "GROUP", code: ORPHAN_GROUP_CODE, label: "削除候補" },
        旧メモ: { type: "SINGLE_LINE_TEXT", code: "旧メモ", label: "旧メモ" },
      },
      layout: [
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "書名" }] },
        {
          type: "GROUP",
          code: ORPHAN_GROUP_CODE,
          layout: [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "旧メモ" }] }],
        },
      ],
    });

    expect(spec["layout"]).toBe("stacked");
    expect((spec["fields"] as { group?: string }[]).every((f) => f.group === undefined)).toBe(true);
    // 自分で作ったグループを「表現できない」と言わない。
    expect(warnings).toEqual([]);
  });

  it("ラベルからコードに戻せないときは、コードを group の名前にする", () => {
    // 名前は group に書く値なので、そこからコードに戻せないと往復で別のグループができる。
    const { spec } = toAppSpecFromKintone({
      name: "蔵書",
      properties: {
        書名: properties.書名,
        貸出_2: { type: "GROUP", code: "貸出_2", label: "貸出" },
      },
      layout: [
        {
          type: "GROUP",
          code: "貸出_2",
          layout: [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "書名" }] }],
        },
      ],
    });

    const group = (spec["fields"] as { group?: string }[])[0]!.group!;
    expect(group).toBe("貸出_2");
    expect(sectionCodeOf(group)).toBe("貸出_2");
  });
});

describe("セクションでの差分", () => {
  const spec = (fields: unknown[]) => parseAppSpec({ name: "蔵書", layout: "sections", fields });
  const text = (label: string, group: string) => ({ type: "SINGLE_LINE_TEXT", label, group });

  it("pull した spec をそのまま update してもレイアウトを組み直さない", () => {
    // ここが崩れると、毎回フォームが書き換わる。
    const current = spec([text("書名", "書誌情報"), text("著者", "書誌情報")]);
    expect(diffAppSpec(current, spec([text("書名", "書誌情報"), text("著者", "書誌情報")])).layout.willApply)
      .toBe(false);
  });

  it("ラベルだけ変えてもレイアウトには触らない", () => {
    const current = spec([text("書名", "書誌情報")]);
    const desired = parseAppSpec({
      name: "蔵書",
      layout: "sections",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "タイトル", code: "書名", group: "書誌情報" }],
    });

    expect(diffAppSpec(current, desired).layout.willApply).toBe(false);
  });

  it("フィールドが増えたら組み直す (でないとセクションの外に出る)", () => {
    const current = spec([text("書名", "書誌情報")]);
    const diff = diffAppSpec(current, spec([text("書名", "書誌情報"), text("著者", "書誌情報")]));

    expect(diff.layout.membersChanged).toBe(true);
    expect(diff.layout.willApply).toBe(true);
  });

  it("group を移したら組み直す", () => {
    const current = spec([text("書名", "書誌情報")]);
    const diff = diffAppSpec(current, spec([text("書名", "貸出")]));

    expect(diff.layout.groupsChanged).toBe(true);
    expect(diff.layout.willApply).toBe(true);
  });
});

describe("更新時のレイアウト組み立て", () => {
  it("既存のグループを解いて、目標どおりに組み直す", () => {
    const layout = buildUpdatedLayout({
      current: [
        {
          type: "GROUP",
          code: "書誌情報",
          layout: [{ type: "ROW", fields: [field("書名")] }],
        },
        { type: "ROW", fields: [field("貸出日", "DATE")] },
      ],
      desired: [field("書名"), field("貸出日", "DATE")],
      orphans: [],
      regroup: true,
      sections: true,
      groups: { 書名: "書誌情報", 貸出日: "貸出" },
    });

    expect(shape(layout)).toEqual([
      { group: "書誌情報", layout: [["書名"]] },
      { group: "貸出", layout: [["貸出日"]] },
    ]);
  });

  it("目標から消えたグループは空のまま残す (勝手に消さない)", () => {
    const layout = buildUpdatedLayout({
      current: [
        { type: "GROUP", code: "旧区分", layout: [{ type: "ROW", fields: [field("書名")] }] },
      ],
      desired: [field("書名")],
      orphans: [],
      regroup: true,
      sections: true,
      groups: {},
    });

    expect(shape(layout)).toEqual([["書名"], { group: "旧区分", layout: [] }]);
  });

  it("セクションを使っていても、退避したフィールドは削除候補へ入る", () => {
    const layout = buildUpdatedLayout({
      current: [
        {
          type: "GROUP",
          code: "書誌情報",
          layout: [{ type: "ROW", fields: [field("書名"), field("旧メモ")] }],
        },
      ],
      desired: [field("書名")],
      orphans: ["旧メモ"],
      regroup: true,
      sections: true,
      groups: { 書名: "書誌情報" },
    });

    // グループの入れ子は kintone が許さないので、退避先は必ず外側に出る。
    expect(shape(layout)).toEqual([
      { group: "書誌情報", layout: [["書名"]] },
      { group: ORPHAN_GROUP_CODE, layout: [["旧メモ"]] },
    ]);
    expect(collectLayoutFields(layout).map((f) => f.code).sort()).toEqual(["旧メモ", "書名"]);
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
    FIELDSMITH_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fieldsmith-sec-")),
  };
  saveToken(
    BASE_URL,
    { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scope: REQUIRED_SCOPE },
    env,
  );
  return env;
}

const polling = { initialDelayMs: 0, maxDelayMs: 0, sleep: noSleep };

describe("deploy がグループを作る", () => {
  it("グループフィールドを追加し、入れ子のレイアウトを送る", async () => {
    const { server, mock } = setupKintoneMock({
      // フィールド追加直後の kintone が返すレイアウト。
      layout: [
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "書名" }] },
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "著者" }] },
        { type: "GROUP", code: "書誌情報", layout: [] },
      ],
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    try {
      await deployAppSpec(
        parseAppSpec({
          name: "蔵書管理",
          layout: "sections",
          fields: [
            { type: "SINGLE_LINE_TEXT", label: "書名", group: "書誌情報" },
            { type: "SINGLE_LINE_TEXT", label: "著者", group: "書誌情報" },
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
    expect(properties["書誌情報"]).toEqual({
      type: "GROUP",
      code: "書誌情報",
      label: "書誌情報",
      noLabel: false,
      openGroup: true,
    });

    const sent = mock.callsTo("updateLayout")[0]!.body["layout"] as LayoutRow[];
    expect(shape(sent)).toEqual([{ group: "書誌情報", layout: [["書名", "著者"]] }]);
  });
});

describe("update がグループを増やさない", () => {
  const run = async (
    desired: unknown,
    existing: {
      properties: Record<string, Record<string, unknown>>;
      layout: unknown[];
    },
  ) => {
    const { server, mock } = setupKintoneMock({
      existing: { settings: { name: "蔵書管理" }, properties: existing.properties },
      layout: existing.layout,
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();
    try {
      const result = await updateApp(
        "761",
        parseAppSpec(desired),
        createAuthenticatedKintone({ config, env }),
        { polling },
      );
      return { result, mock };
    } finally {
      server.close();
      rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
    }
  };

  const existing = {
    properties: {
      書名: { type: "SINGLE_LINE_TEXT", code: "書名", label: "書名" },
      書誌情報: { type: "GROUP", code: "書誌情報", label: "書誌情報", openGroup: true },
    },
    layout: [
      {
        type: "GROUP",
        code: "書誌情報",
        layout: [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "書名" }] }],
      },
    ],
  };

  it("既に在るグループは作り直さない", async () => {
    const { mock } = await run(
      {
        name: "蔵書管理",
        layout: "sections",
        fields: [
          { type: "SINGLE_LINE_TEXT", label: "書名", code: "書名", group: "書誌情報" },
          { type: "SINGLE_LINE_TEXT", label: "著者", code: "著者", group: "書誌情報" },
        ],
      },
      existing,
    );

    const added = mock.callsTo("fields")[0]!.body["properties"] as Record<string, unknown>;
    expect(Object.keys(added)).toEqual(["著者"]);
  });

  it("目標から消えたグループを知らせる", async () => {
    const { result } = await run(
      {
        name: "蔵書管理",
        layout: "sections",
        fields: [{ type: "SINGLE_LINE_TEXT", label: "書名", code: "書名", group: "貸出" }],
      },
      existing,
    );

    expect(result.warnings.join("\n")).toMatch(/グループ「書誌情報」は AppSpec に無くなりました/);
  });
});
