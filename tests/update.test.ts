import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KintoneConfig } from "../src/config.js";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import { UnsupportedUpdateError, updateApp } from "../src/kintone/deploy.js";
import { REQUIRED_SCOPE } from "../src/kintone/oauth.js";
import { saveToken } from "../src/kintone/tokenStore.js";
import { parseAppSpec } from "../src/spec/appSpec.js";
import { ORPHAN_GROUP_CODE } from "../src/spec/layout.js";
import { BASE_URL, noSleep, setupKintoneMock } from "./kintoneMock.js";

/**
 * 既存アプリの更新。
 * 「消さない」「勝手に運用環境へ出さない」という 2 つの約束を固定する。
 */

const config: KintoneConfig = {
  baseUrl: BASE_URL,
  clientId: "c",
  clientSecret: "s",
  redirectUri: "https://app.example.com/cb",
  authorizationEndpoint: `${BASE_URL}/oauth2/authorization`,
  tokenEndpoint: `${BASE_URL}/oauth2/token`,
};

function withToken(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { VCK_CONFIG_DIR: mkdtempSync(join(tmpdir(), "vck-upd-")) };
  saveToken(
    BASE_URL,
    { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scope: REQUIRED_SCOPE },
    env,
  );
  return env;
}

const existingProperties = {
  案件名: { type: "SINGLE_LINE_TEXT", code: "案件名", label: "案件名" },
  顧客名: { type: "SINGLE_LINE_TEXT", code: "顧客名", label: "顧客名" },
};

const polling = { initialDelayMs: 0, maxDelayMs: 0, sleep: noSleep };

/** モックを立てて update を実行し、飛んだ呼び出しを返す。 */
async function run(desiredSpec: unknown, options: { deploy?: boolean } = {}) {
  const { server, mock } = setupKintoneMock({
    existing: { settings: { name: "案件管理" }, properties: existingProperties },
  });
  server.listen({ onUnhandledRequest: "error" });
  const env = withToken();

  try {
    const result = await updateApp(
      "761",
      parseAppSpec(desiredSpec),
      createAuthenticatedKintone({ config, env }),
      { ...options, polling },
    );
    return { result, mock };
  } finally {
    server.close();
    rmSync(env["VCK_CONFIG_DIR"]!, { recursive: true, force: true });
  }
}

const text = (label: string, over: Record<string, unknown> = {}) => ({
  type: "SINGLE_LINE_TEXT",
  label,
  code: label,
  ...over,
});

describe("既定では運用環境へ反映しない", () => {
  it("動作テスト環境で止める", async () => {
    const { result, mock } = await run({
      name: "案件管理",
      layout: "stacked",
      fields: [text("案件名"), text("顧客名"), text("金額")],
    });

    expect(result.deployed).toBe(false);
    // 反映もポーリングも行わない。
    expect(mock.callsTo("deploy")).toHaveLength(0);
    expect(mock.callsTo("deployStatus")).toHaveLength(0);
  });

  it("--deploy を指定したときだけ反映する", async () => {
    const { result, mock } = await run(
      { name: "案件管理", layout: "stacked", fields: [text("案件名"), text("顧客名"), text("金額")] },
      { deploy: true },
    );

    expect(result.deployed).toBe(true);
    expect(mock.callsTo("deploy")).toHaveLength(1);
    expect(mock.callsTo("deployStatus").length).toBeGreaterThan(0);
  });
});

describe("フィールドの追加と変更", () => {
  it("増えたフィールドだけを追加する", async () => {
    const { mock } = await run({
      name: "案件管理",
      layout: "stacked",
      fields: [text("案件名"), text("顧客名"), text("金額")],
    });

    const added = mock.callsTo("fields")[0]!.body["properties"] as Record<string, unknown>;
    expect(Object.keys(added)).toEqual(["金額"]);
  });

  it("変わったフィールドだけを送る (この API は部分指定でよい)", async () => {
    const { mock } = await run({
      name: "案件管理",
      layout: "stacked",
      fields: [text("案件名", { required: true }), text("顧客名")],
    });

    const updated = mock.callsTo("updateFields")[0]!.body["properties"] as Record<string, unknown>;
    expect(Object.keys(updated)).toEqual(["案件名"]);
    expect(mock.callsTo("fields")).toHaveLength(0);
  });

  it("変更が無ければ何も送らない", async () => {
    const { result, mock } = await run({
      name: "案件管理",
      layout: "stacked",
      fields: [text("案件名"), text("顧客名")],
    });

    expect(result.diff.added).toEqual([]);
    // 読み取り以外は起きない。
    const writes = mock.calls.filter((call) => call.method !== "GET");
    expect(writes).toEqual([]);
  });
});

describe("フィールドを消さない", () => {
  it("目標から消えたフィールドは削除候補グループへ移す", async () => {
    const { result, mock } = await run({
      name: "案件管理",
      layout: "stacked",
      fields: [text("案件名")],
    });

    expect(result.diff.orphaned.map((o) => o.code)).toEqual(["顧客名"]);

    // 削除 API は呼ばない。
    expect(mock.calls.some((call) => call.method === "DELETE")).toBe(false);

    // 削除候補グループを作り、レイアウトでそこへ移す。
    const added = mock.callsTo("fields")[0]!.body["properties"] as Record<string, { type: string; openGroup: boolean }>;
    expect(added[ORPHAN_GROUP_CODE]).toMatchObject({ type: "GROUP", openGroup: false });

    const layout = mock.callsTo("updateLayout")[0]!.body["layout"] as Record<string, unknown>[];
    const group = layout.find((row) => row["code"] === ORPHAN_GROUP_CODE);
    expect(group).toBeDefined();
    expect(JSON.stringify(group)).toContain("顧客名");
  });
});

describe("何度流しても同じ結果になる", () => {
  it("既に削除候補へ移してあるフィールドは、もう動かさない", async () => {
    // 動作テスト環境を読むので、前回の退避が見える。
    const { server, mock } = setupKintoneMock({
      existing: {
        settings: { name: "案件管理" },
        properties: {
          ...existingProperties,
          _削除候補: { type: "GROUP", code: ORPHAN_GROUP_CODE, label: "削除候補" },
        },
      },
      layout: [
        { type: "ROW", fields: [{ code: "案件名", type: "SINGLE_LINE_TEXT" }] },
        {
          type: "GROUP",
          code: ORPHAN_GROUP_CODE,
          layout: [{ type: "ROW", fields: [{ code: "顧客名", type: "SINGLE_LINE_TEXT" }] }],
        },
      ],
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const result = await updateApp(
      "761",
      parseAppSpec({ name: "案件管理", layout: "stacked", fields: [text("案件名")] }),
      createAuthenticatedKintone({ config, env }),
      { polling },
    );
    server.close();
    rmSync(env["VCK_CONFIG_DIR"]!, { recursive: true, force: true });

    // 差分としては削除候補のままだが、動かす必要はない。
    expect(result.diff.orphaned.map((o) => o.code)).toEqual(["顧客名"]);
    expect(result.pendingOrphans).toEqual([]);
    expect(mock.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("削除候補グループを二重に作らない", async () => {
    const { server, mock } = setupKintoneMock({
      existing: {
        settings: { name: "案件管理" },
        properties: {
          ...existingProperties,
          _削除候補: { type: "GROUP", code: ORPHAN_GROUP_CODE, label: "削除候補" },
          金額: { type: "NUMBER", code: "金額", label: "金額" },
        },
      },
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await updateApp(
      "761",
      parseAppSpec({ name: "案件管理", layout: "stacked", fields: [text("案件名"), text("顧客名")] }),
      createAuthenticatedKintone({ config, env }),
      { polling },
    );
    server.close();
    rmSync(env["VCK_CONFIG_DIR"]!, { recursive: true, force: true });

    const added = mock.callsTo("fields")[0]?.body["properties"] as Record<string, unknown> | undefined;
    expect(added === undefined || !(ORPHAN_GROUP_CODE in added)).toBe(true);
  });
});

describe("型変更は実行しない", () => {
  it("実現できないので、何も送らずに失敗させる", async () => {
    const error = await run({
      name: "案件管理",
      layout: "stacked",
      fields: [{ type: "MULTI_LINE_TEXT", label: "案件名", code: "案件名" }, text("顧客名")],
    })
      .then(() => null)
      .catch((e: unknown) => e as UnsupportedUpdateError);

    expect(error).toBeInstanceOf(UnsupportedUpdateError);
    expect(error!.message).toMatch(/型を変更できない/);
    // 直し方を示す。
    expect(error!.message).toMatch(/別のフィールドコード/);
    expect(error!.message).toMatch(/案件名: SINGLE_LINE_TEXT → MULTI_LINE_TEXT/);
  });
});

describe("アプリ説明の HTML", () => {
  /**
   * kintone は説明を HTML で返し、全角括弧なども数値文字参照に変える。
   * 戻さないと update のたびに「説明が変わった」と判定され、差分が永遠に消えない。
   */
  it("数値文字参照を戻すので、同じ説明なら差分にならない", async () => {
    const { server, mock } = setupKintoneMock({
      existing: {
        settings: { name: "案件管理", description: "営業案件を管理します&#xff08;更新版&#xff09;" },
        properties: existingProperties,
      },
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const result = await updateApp(
      "761",
      parseAppSpec({
        name: "案件管理",
        description: "営業案件を管理します（更新版）",
        layout: "stacked",
        fields: [text("案件名"), text("顧客名")],
      }),
      createAuthenticatedKintone({ config, env }),
      { polling },
    );
    server.close();
    rmSync(env["VCK_CONFIG_DIR"]!, { recursive: true, force: true });

    expect(result.diff.app).toEqual([]);
    expect(mock.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
