import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KintoneConfig } from "../src/config.js";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import {
  differences,
  moveAfter,
  needsMove,
  planLinks,
  toLookup,
  toReferenceTable,
  LinkValidationError,
} from "../src/kintone/link.js";
import { REQUIRED_SCOPE } from "../src/kintone/oauth.js";
import { saveToken } from "../src/kintone/tokenStore.js";
import { LinkSpecValidationError, parseLinkFile } from "../src/spec/linkSpec.js";
import type { LayoutField, LayoutRow } from "../src/spec/layout.js";
import { BASE_URL } from "./kintoneMock.js";

/**
 * アプリ間の結線。
 *
 * AppSpec に入れると spec が特定の kintone 環境に縛られるので、
 * 環境に依存する部分だけを別のファイルに閉じ込めている。
 */

const lookup = (over: Record<string, unknown> = {}) => ({
  type: "LOOKUP",
  app: 777,
  code: "本棚ID",
  relatedApp: 776,
  relatedKeyField: "棚ID",
  ...over,
});
const reference = (over: Record<string, unknown> = {}) => ({
  type: "REFERENCE_TABLE",
  app: 777,
  code: "同じ棚の本",
  label: "同じ棚の本",
  relatedApp: 776,
  condition: { field: "本棚ID", relatedField: "棚ID" },
  displayFields: ["棚名"],
  ...over,
});

describe("結線ファイルの検証", () => {
  const issuesOf = (input: unknown): string[] => {
    try {
      parseLinkFile(input);
    } catch (error) {
      return (error as LinkSpecValidationError).issues.map((issue) => issue.message);
    }
    return [];
  };

  it("問題が無ければ通る", () => {
    expect(issuesOf({ links: [lookup(), reference()] })).toEqual([]);
  });

  it("アプリは数値でも文字列でも書ける", () => {
    // 数値はアプリ ID、文字列はアプリコード。文字列で書けば環境に依存しない。
    const file = parseLinkFile({ links: [lookup({ app: "蔵書", relatedApp: 776 })] });
    expect(file.links[0]!.app).toBe("蔵書");
    expect(file.links[0]!.relatedApp).toBe(776);
  });

  it("同じアプリの同じフィールドを 2 回結線しない", () => {
    expect(issuesOf({ links: [lookup(), lookup()] }).join()).toMatch(/重複しています/);
  });

  it("別のアプリなら同じフィールドコードでよい", () => {
    expect(issuesOf({ links: [lookup(), lookup({ app: 778 })] })).toEqual([]);
  });

  it("関連レコード一覧のコードは、フィールドコードの規約を満たす", () => {
    // link が作るフィールドなので、作れない名前を先に弾く。
    expect(issuesOf({ links: [reference({ code: "1番目" })] }).join()).toMatch(/先頭に数字/);
  });

  it("知らないキーを書いたら弾く", () => {
    expect(issuesOf({ links: [lookup({ relatedKeyFeild: "棚ID" })] }).length).toBeGreaterThan(0);
  });
});

describe("kintone に送る形", () => {
  it("書いていない項目は送らない", () => {
    // kintone は書かなかった項目を勝手に埋める。送らないことで現状維持にする。
    expect(toLookup(parseLinkFile({ links: [lookup()] }).links[0] as never, "776")).toEqual({
      relatedApp: { app: "776" },
      relatedKeyField: "棚ID",
    });
  });

  it("書いた項目は送る", () => {
    const link = parseLinkFile({
      links: [lookup({ sort: "棚ID asc", lookupPickerFields: ["棚ID"] })],
    }).links[0];
    expect(toLookup(link as never, "776")).toMatchObject({
      sort: "棚ID asc",
      lookupPickerFields: ["棚ID"],
    });
  });

  it("size は文字列にする (kintone が文字列で返すため)", () => {
    const link = parseLinkFile({ links: [reference({ size: 5 })] }).links[0];
    expect(toReferenceTable(link as never, "776")["size"]).toBe("5");
  });
});

describe("何を差分とみなすか", () => {
  // kintone が埋めた値を差分にすると、中身が同じなのに毎回「変わった」と言い続ける。
  const current = {
    relatedApp: { app: "776", code: "" },
    relatedKeyField: "棚ID",
    fieldMappings: [],
    lookupPickerFields: ["棚ID"],
    filterCond: "",
    sort: "レコード番号 desc",
  };

  it("書いていない項目は差分にしない", () => {
    expect(differences(current, { relatedApp: { app: "776" }, relatedKeyField: "棚ID" })).toEqual([]);
  });

  it("書いた項目が違えば差分にする", () => {
    expect(
      differences(current, { relatedApp: { app: "776" }, relatedKeyField: "棚名" }),
    ).toEqual(["relatedKeyField"]);
  });

  it("参照先アプリの違いを拾う", () => {
    expect(differences(current, { relatedApp: { app: "999" } })).toEqual(["relatedApp"]);
  });

  it("kintone が付ける code は比べない", () => {
    // relatedApp は {app, code} で返るが、こちらは app しか送らない。
    expect(differences(current, { relatedApp: { app: "776" } })).toEqual([]);
  });
});

describe("置き場所", () => {
  const field = (code: string, type = "SINGLE_LINE_TEXT"): LayoutField => ({ code, type });
  const row = (...codes: string[]): LayoutRow => ({ type: "ROW", fields: codes.map((c) => field(c)) });
  const shape = (l: readonly LayoutRow[]): string[][] =>
    l.map((r) => ((r as { fields?: LayoutField[] }).fields ?? []).map((f) => f.code));

  it("指定したフィールドの直後へ移す", () => {
    const layout = [row("書名"), row("棚名"), row("同じ棚の本")];
    expect(shape(moveAfter(layout, "同じ棚の本", "書名"))).toEqual([["書名"], ["同じ棚の本"], ["棚名"]]);
  });

  it("他のフィールドと同じ行に居たら、抜き出して単独行にする", () => {
    const layout = [row("書名", "同じ棚の本"), row("棚名")];
    expect(shape(moveAfter(layout, "同じ棚の本", "棚名"))).toEqual([["書名"], ["棚名"], ["同じ棚の本"]]);
  });

  it("まだ無いフィールドも置ける", () => {
    // 追加した直後は kintone がフォーム末尾に置くので、そこから動かす。
    const layout = [row("書名"), row("棚名")];
    expect(shape(moveAfter(layout, "同じ棚の本", "書名"))).toEqual([["書名"], ["同じ棚の本"], ["棚名"]]);
  });

  it("目印が見つからなければ末尾に置く (捨てはしない)", () => {
    const layout = [row("書名")];
    expect(shape(moveAfter(layout, "同じ棚の本", "居ない"))).toEqual([["書名"], ["同じ棚の本"]]);
  });

  it("既に目的の位置に居れば動かす必要はない", () => {
    const layout = [row("書名"), row("同じ棚の本"), row("棚名")];
    expect(needsMove(layout, "同じ棚の本", "書名")).toBe(false);
    expect(needsMove(layout, "同じ棚の本", "棚名")).toBe(true);
  });

  it("placeAfter が無ければ動かさない", () => {
    expect(needsMove([row("書名")], "同じ棚の本", undefined)).toBe(false);
  });
});

/* ------------------------------ 実物との突き合わせ ------------------------------ */

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

/** アプリごとに違うフォームを返すモック。結線は 2 つのアプリを跨ぐので要る。 */
function mockApps(apps: Record<string, { name: string; properties: Record<string, unknown>; layout?: unknown[] }>) {
  const pick = (request: Request) => apps[new URL(request.url).searchParams.get("app") ?? ""]!;
  return setupServer(
    http.get(`${BASE_URL}/k/v1/apps.json`, ({ request }) => {
      // codes は codes[0], codes[1] ... と並ぶ。1 つだけ見ると 2 アプリの結線が解決できない。
      const params = new URL(request.url).searchParams;
      const codes = [...params.entries()]
        .filter(([key]) => key.startsWith("codes["))
        .map(([, value]) => value);
      const found = codes.flatMap((code) => {
        const hit = Object.entries(apps).find(([, a]) => a.name === code);
        return hit === undefined ? [] : [{ appId: hit[0], code, name: code }];
      });
      return HttpResponse.json({ apps: found });
    }),
    http.get(`${BASE_URL}/k/v1/preview/app/settings.json`, ({ request }) =>
      HttpResponse.json({ name: pick(request).name, revision: "1" }),
    ),
    http.get(`${BASE_URL}/k/v1/preview/app/form/fields.json`, ({ request }) =>
      HttpResponse.json({ properties: pick(request).properties, revision: "1" }),
    ),
    http.get(`${BASE_URL}/k/v1/preview/app/form/layout.json`, ({ request }) =>
      HttpResponse.json({ layout: pick(request).layout ?? [], revision: "1" }),
    ),
  );
}

function withToken(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FIELDSMITH_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fieldsmith-link-")) };
  saveToken(
    BASE_URL,
    { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scope: REQUIRED_SCOPE },
    env,
  );
  return env;
}

const 蔵書 = {
  name: "蔵書",
  properties: {
    書名: { type: "SINGLE_LINE_TEXT", code: "書名" },
    本棚ID: { type: "SINGLE_LINE_TEXT", code: "本棚ID" },
    棚名: { type: "SINGLE_LINE_TEXT", code: "棚名" },
  },
  layout: [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "書名" }] }],
};
const 本棚 = {
  name: "本棚",
  properties: {
    棚ID: { type: "SINGLE_LINE_TEXT", code: "棚ID", unique: true },
    棚名: { type: "SINGLE_LINE_TEXT", code: "棚名" },
  },
};

async function plan(links: unknown[], apps = { "777": 蔵書, "776": 本棚 }) {
  const server = mockApps(apps);
  server.listen({ onUnhandledRequest: "error" });
  const env = withToken();
  try {
    return await planLinks(parseLinkFile({ links }), createAuthenticatedKintone({ config, env }));
  } finally {
    server.close();
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  }
}

const failure = async (links: unknown[]): Promise<string[]> => {
  try {
    await plan(links);
  } catch (error) {
    return (error as LinkValidationError).issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
  return [];
};

describe("実物と突き合わせる", () => {
  it("まだ無い結線は「作る」", async () => {
    const result = await plan([reference()]);
    expect(result.entries[0]).toMatchObject({ action: "add", appId: "777", relatedAppId: "776" });
  });

  it("ルックアップは既にあるフィールドに設定を足す", async () => {
    const result = await plan([lookup()]);
    expect(result.entries[0]).toMatchObject({ action: "update", hostType: "SINGLE_LINE_TEXT" });
  });

  it("アプリコードをアプリ ID に解決する", async () => {
    const result = await plan([lookup({ app: "蔵書", relatedApp: "本棚" })]);
    expect(result.entries[0]).toMatchObject({ appId: "777", relatedAppId: "776" });
  });

  it("ルックアップにするフィールドが無ければ、AppSpec で作るよう伝える", async () => {
    expect((await failure([lookup({ code: "居ない" })])).join()).toMatch(/AppSpec で作ってください/);
  });

  it("キーに重複禁止が無ければ弾く", async () => {
    // kintone の決まり。ここで弾かないとデプロイの途中で落ちる。
    expect((await failure([lookup({ relatedKeyField: "棚名" })])).join()).toMatch(/重複禁止/);
  });

  it("相手アプリに無いフィールドを弾く", async () => {
    expect((await failure([reference({ displayFields: ["居ない"] })])).join()).toMatch(
      /"居ない" は参照先の 本棚 にありません/,
    );
  });

  it("別の型のフィールドを踏み潰さない", async () => {
    expect((await failure([reference({ code: "書名" })])).join()).toMatch(
      /既に SINGLE_LINE_TEXT として存在します/,
    );
  });

  it("ルックアップにできない型を弾く", async () => {
    const apps = {
      "777": { ...蔵書, properties: { ...蔵書.properties, 本棚ID: { type: "DATE", code: "本棚ID" } } },
      "776": 本棚,
    };
    const caught = await plan([lookup()], apps).catch((e: unknown) => e as LinkValidationError);
    expect((caught as LinkValidationError).issues[0]!.message).toMatch(/DATE なのでルックアップにできません/);
  });

  it("ファイルに無い結線は消さずに知らせる", async () => {
    const apps = {
      "777": {
        ...蔵書,
        properties: {
          ...蔵書.properties,
          古い関連: { type: "REFERENCE_TABLE", code: "古い関連" },
        },
      },
      "776": 本棚,
    };
    const result = await plan([lookup()], apps);
    expect(result.warnings.join()).toMatch(/"古い関連" は結線ファイルにありませんが/);
    expect(result.warnings.join()).toMatch(/消しません/);
  });
});
