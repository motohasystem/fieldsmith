import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KintoneConfig } from "../src/config.js";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import { chunk, DeployError, deployAppSpec } from "../src/kintone/deploy.js";
import { REQUIRED_SCOPE } from "../src/kintone/oauth.js";
import { saveToken } from "../src/kintone/tokenStore.js";
import { parseAppSpec } from "../src/spec/appSpec.js";
import { BASE_URL, noSleep, setupKintoneMock } from "./kintoneMock.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config: KintoneConfig = {
  baseUrl: BASE_URL,
  auth: {
    kind: "oauth",
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://app.example.com/oauth/callback",
    authorizationEndpoint: `${BASE_URL}/oauth2/authorization`,
    tokenEndpoint: `${BASE_URL}/oauth2/token`,
  },
};

function withToken(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "fieldsmith-test-"));
  const env: NodeJS.ProcessEnv = { FIELDSMITH_CONFIG_DIR: dir };
  saveToken(
    BASE_URL,
    {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
      scope: REQUIRED_SCOPE,
    },
    env,
  );
  return env;
}

const spec = parseAppSpec({
  name: "案件管理",
  description: "案件を管理します",
  layout: "stacked",
  fields: [
    { type: "SINGLE_LINE_TEXT", label: "案件名", required: true },
    { type: "DROP_DOWN", label: "確度", options: ["高", "中", "低"] },
  ],
  views: [{ name: "全件", type: "LIST", fields: ["案件名", "確度"] }],
  settings: { titleFieldCode: "案件名" },
});

const polling = { initialDelayMs: 0, maxDelayMs: 0, sleep: noSleep };

describe("deployAppSpec", () => {
  it("テスト環境への構築から運用環境への反映まで、正しい順序で呼ぶ", async () => {
    const { server, mock } = setupKintoneMock({ deployStatuses: ["PROCESSING", "SUCCESS"] });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const result = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling });

    server.close();
    expect(result.appId).toBe("42");
    expect(mock.calls.map((call) => call.path)).toEqual([
      "app",
      "fields",
      "settings",
      "views",
      "deploy",
      "deployStatus",
      "deployStatus",
    ]);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("revision を各ステップに引き回す", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    // app.json が revision "1" を返し、以降 fields → settings → views と 1 ずつ増えていく。
    expect(mock.callsTo("fields")[0]!.body["revision"]).toBe("1");
    expect(mock.callsTo("settings")[0]!.body["revision"]).toBe("2");
    expect(mock.callsTo("views")[0]!.body["revision"]).toBe("3");
    expect(mock.callsTo("deploy")[0]!.body["apps"]).toEqual([{ app: "42", revision: "4" }]);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("icon があれば画像をアップロードして一般設定に紐付ける", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const withIcon = parseAppSpec({
      name: "書籍管理",
      layout: "stacked",
      icon: "📚",
      iconBackground: "#2563eb",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "書名" }],
    });
    await deployAppSpec(withIcon, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    // 画像はフィールド追加のあと、一般設定より前にアップロードする (fileKey が要るため)。
    expect(mock.calls.map((c) => c.path)).toEqual([
      "app",
      "fields",
      "file",
      "settings",
      "deploy",
      "deployStatus",
    ]);
    expect((mock.callsTo("file")[0]!.body["bytes"] as number)).toBeGreaterThan(1000);
    expect(mock.callsTo("settings")[0]!.body["icon"]).toEqual({
      type: "FILE",
      file: { fileKey: "test-file-key" },
    });
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("icon だけの指定でも一般設定 API を呼ぶ", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const iconOnly = parseAppSpec({
      name: "在庫",
      layout: "stacked",
      icon: "在",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "品名" }],
    });
    await deployAppSpec(iconOnly, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    // description も theme も無いが、アイコンのために settings を送る必要がある。
    expect(Object.keys(mock.callsTo("settings")[0]!.body)).toEqual(["app", "revision", "icon"]);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("icon が無ければ画像をアップロードしない", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    expect(mock.callsTo("file")).toHaveLength(0);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("アイコンのアップロードに失敗したら、そのステップとして報告する", async () => {
    const { server, mock } = setupKintoneMock({ failOnce: { path: "file", status: 403, code: "CB_OA01" } });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const withIcon = parseAppSpec({
      name: "書籍管理",
      layout: "stacked",
      icon: "📚",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "書名" }],
    });
    const error = await deployAppSpec(withIcon, createAuthenticatedKintone({ config, env }), { polling })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(error!.step).toBe("uploadIcon");
    expect(error!.message).toMatch(/スコープが不足/);
    expect(mock.callsTo("deploy")).toHaveLength(0);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("スペース指定時は REST API を直接叩く (OAuth 非対応の空間 API を避ける)", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), {
      polling,
      spaceId: "12",
      threadId: "34",
    });
    server.close();

    // rest-api-client の addApp() は space 指定時に GET /k/v1/space.json を呼ぶが、
    // その API は OAuth 認証に対応していない。space.json が呼ばれていないことを確かめる。
    expect(mock.callsTo("spaceInfo")).toHaveLength(0);
    expect(mock.callsTo("app")[0]!.body).toEqual({
      name: "案件管理",
      space: "12",
      thread: "34",
    });
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("スレッド未指定でも space だけ送る", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), {
      polling,
      spaceId: 12,
    });
    server.close();

    expect(mock.callsTo("app")[0]!.body).toEqual({ name: "案件管理", space: 12 });
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("スペース指定で失敗したら、スレッド ID の指定方法を案内する", async () => {
    const { server } = setupKintoneMock({ failOnce: { path: "app", status: 400 } });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), {
      polling,
      spaceId: "12",
    })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(error!.step).toBe("createApp");
    expect(error!.message).toMatch(/--thread/);
    expect(error!.message).toMatch(/space\/\{スペースID\}\/thread/);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("スペースを指定しなければ space を送らない (スペースに属さないアプリになる)", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    expect(mock.callsTo("app")[0]!.body).toEqual({ name: "案件管理" });
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("ゲストスペースでは URL の前置きが変わる", async () => {
    // ゲストスペースのアプリは /k/guest/{id}/v1/... を使う。
    // 通常の URL で待ち受けているモックには当たらないので、前置きの違いが検証できる。
    const { server, mock } = setupKintoneMock({ guestSpaceId: 7 });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env, guestSpaceId: 7 }), {
      polling,
      spaceId: "7",
      guestSpaceId: 7,
    });
    server.close();

    expect(mock.callsTo("app")).toHaveLength(1);
    expect(mock.callsTo("deployStatus")).toHaveLength(1);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("既定でフォームの並びを整える", async () => {
    const { server, mock } = setupKintoneMock({
      // kintone はフィールド追加直後、1 行 1 フィールドで返す。
      layout: [
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "案件名" }] },
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "顧客名" }] },
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "担当" }] },
        { type: "ROW", fields: [{ type: "DROP_DOWN", code: "確度" }] },
      ],
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const grouped = parseAppSpec({
      name: "案件管理",
      fields: [
        { type: "SINGLE_LINE_TEXT", label: "案件名" },
        { type: "SINGLE_LINE_TEXT", label: "顧客名" },
        { type: "SINGLE_LINE_TEXT", label: "担当" },
        { type: "DROP_DOWN", label: "確度", options: ["高", "低"] },
      ],
    });
    await deployAppSpec(grouped, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    // 推測せず、実際に置かれたレイアウトを取ってから並べ替える。
    expect(mock.calls.map((c) => c.path)).toEqual([
      "app",
      "fields",
      "getLayout",
      "updateLayout",
      "deploy",
      "deployStatus",
    ]);
    expect(mock.callsTo("updateLayout")[0]!.body["layout"]).toEqual([
      {
        type: "ROW",
        fields: [
          { type: "SINGLE_LINE_TEXT", code: "案件名" },
          { type: "SINGLE_LINE_TEXT", code: "顧客名" },
          { type: "SINGLE_LINE_TEXT", code: "担当" },
        ],
      },
      { type: "ROW", fields: [{ type: "DROP_DOWN", code: "確度" }] },
    ]);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("layout: stacked ならレイアウトに触らない", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    expect(mock.callsTo("getLayout")).toHaveLength(0);
    expect(mock.callsTo("updateLayout")).toHaveLength(0);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("maxPerRow を指定できる", async () => {
    const { server, mock } = setupKintoneMock({
      layout: [
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "a" }] },
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "b" }] },
        { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "c" }] },
      ],
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const twoPerRow = parseAppSpec({
      name: "二列",
      layout: { mode: "grouped", maxPerRow: 2 },
      fields: [
        { type: "SINGLE_LINE_TEXT", label: "a", code: "a" },
        { type: "SINGLE_LINE_TEXT", label: "b", code: "b" },
        { type: "SINGLE_LINE_TEXT", label: "c", code: "c" },
      ],
    });
    await deployAppSpec(twoPerRow, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    const sent = mock.callsTo("updateLayout")[0]!.body["layout"] as { fields: unknown[] }[];
    expect(sent.map((row) => row.fields.length)).toEqual([2, 1]);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("設定・一覧の指定が無ければその API を呼ばない", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const minimal = parseAppSpec({
      name: "最小",
      layout: "stacked",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "名前" }],
    });
    await deployAppSpec(minimal, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    expect(mock.callsTo("settings")).toHaveLength(0);
    expect(mock.callsTo("views")).toHaveLength(0);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("100 件を超えるフィールドを分割して送る", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const many = parseAppSpec({
      name: "大量",
      layout: "stacked",
      fields: Array.from({ length: 250 }, (_, index) => ({
        type: "SINGLE_LINE_TEXT",
        label: `項目${index}`,
        code: `f${index}`,
      })),
    });
    await deployAppSpec(many, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    const fieldCalls = mock.callsTo("fields");
    expect(fieldCalls).toHaveLength(3);
    expect(Object.keys(fieldCalls[0]!.body["properties"] as object)).toHaveLength(100);
    expect(Object.keys(fieldCalls[2]!.body["properties"] as object)).toHaveLength(50);
    // 分割しても revision は連続して引き回される。
    expect(fieldCalls[1]!.body["revision"]).toBe("2");
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("PROCESSING が続く間はポーリングし、SUCCESS で完了する", async () => {
    const { server, mock } = setupKintoneMock({
      deployStatuses: ["PROCESSING", "PROCESSING", "PROCESSING", "SUCCESS"],
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling });
    server.close();

    expect(mock.callsTo("deployStatus")).toHaveLength(4);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it.each([
    ["FAIL", /反映に失敗/],
    ["CANCEL", /キャンセル/],
  ])("反映結果が %s なら appId 付きで失敗させる", async (status, pattern) => {
    const { server } = setupKintoneMock({ deployStatuses: [status as "FAIL"] });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(error).toBeInstanceOf(DeployError);
    expect(error!.appId).toBe("42");
    expect(error!.step).toBe("polling");
    expect(error!.message).toMatch(pattern);
    expect(error!.message).toMatch(/42/);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("タイムアウトすると打ち切って appId を伝える", async () => {
    const { server } = setupKintoneMock({ deployStatuses: ["PROCESSING"] });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    let clock = 0;
    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), {
      polling: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        timeoutMs: 100,
        sleep: async () => {
          clock += 60;
        },
        now: () => clock,
      },
    })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(error!.message).toMatch(/完了しませんでした/);
    expect(error!.appId).toBe("42");
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("途中で失敗しても既定では破棄せず、アプリ ID を残す", async () => {
    const { server, mock } = setupKintoneMock({ failOnce: { path: "fields", status: 400 } });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(error!.step).toBe("addFields");
    expect(error!.message).toMatch(/アプリ ID 42 が残っています/);
    expect(mock.callsTo("deploy")).toHaveLength(0);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("--revert-on-failure なら破棄を呼ぶ", async () => {
    const { server, mock } = setupKintoneMock({ failOnce: { path: "fields", status: 400 } });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), {
      polling,
      revertOnFailure: true,
    })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(mock.callsTo("deploy")).toHaveLength(1);
    expect(mock.callsTo("deploy")[0]!.body).toEqual({ apps: [{ app: "42" }], revert: true });
    expect(error!.message).toMatch(/破棄しました/);
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("スコープ不足 (CB_OA01) は対処つきで伝える", async () => {
    // 書き込み系は通り、反映状況の確認だけが 403 になるという実際の壊れ方を再現する。
    const { server } = setupKintoneMock({
      failOnce: { path: "deployStatus", status: 403, code: "CB_OA01" },
    });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(error!.message).toMatch(/スコープが不足/);
    expect(error!.message).toMatch(/fieldsmith login/);
    expect(error!.appId).toBe("42");
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("アプリ作成そのものに失敗したら appId は null", async () => {
    const { server } = setupKintoneMock({ failOnce: { path: "app", status: 403 } });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), { polling })
      .then(() => null)
      .catch((e: unknown) => e as DeployError);
    server.close();

    expect(error!.appId).toBeNull();
    expect(error!.step).toBe("createApp");
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("各ステップの開始と完了を通知し、完了側に detail を添える", async () => {
    const { server } = setupKintoneMock({ deployStatuses: ["PROCESSING", "SUCCESS"] });
    server.listen({ onUnhandledRequest: "error" });
    const env = withToken();

    const events: { step: string; message: string; detail?: string }[] = [];
    await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), {
      polling,
      onProgress: (progress) => events.push({ ...progress }),
    });
    server.close();

    expect(events.map((e) => e.step)).toEqual([
      "createApp",
      "createApp",
      "addFields",
      "addFields",
      "updateSettings",
      "updateSettings",
      "updateViews",
      "updateViews",
      "deploy",
      "polling",
      "polling",
      "polling",
    ]);

    // --verbose で出す補足には、切り分けに要る情報 (revision の遷移) が入っている。
    expect(events[3]!.detail).toMatch(/revision 1 → 2/);
    expect(events[5]!.detail).toMatch(/revision 2 → 3/);
    expect(events[8]!.detail).toMatch(/app=42, revision=4/);

    // ポーリングは毎回その時点の状況を伝える。
    const polls = events.filter((e) => /反映状況/.test(e.message));
    expect(polls.map((e) => e.message)).toEqual(["反映状況: PROCESSING", "反映状況: SUCCESS"]);
    expect(polls[0]!.detail).toMatch(/1 回目の確認/);

    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });
});

describe("chunk", () => {
  it("空なら空配列", () => {
    expect(chunk({}, 10)).toEqual([]);
  });

  it("順序を保って分割する", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`f${i}`, { type: "SINGLE_LINE_TEXT" }]),
    );
    const chunks = chunk(properties, 2);
    expect(chunks.map((c) => Object.keys(c))).toEqual([["f0", "f1"], ["f2", "f3"], ["f4"]]);
  });
});
