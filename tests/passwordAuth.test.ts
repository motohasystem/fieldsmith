import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadKintoneConfig,
  requireOAuth,
  type KintoneConfig,
} from "../src/config.js";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import { deployAppSpec } from "../src/kintone/deploy.js";
import { ReauthRequiredError } from "../src/kintone/oauth.js";
import { parseAppSpec } from "../src/spec/appSpec.js";
import { BASE_URL, noSleep, setupKintoneMock } from "./kintoneMock.js";

/**
 * パスワード認証。
 *
 * OAuth クライアントの登録が要らないぶん導入は楽だが、パスワードを設定に置くことになる。
 * どちらを使っているかで、トークンの扱いと login の要否が変わる。
 */

const PASSWORD_ENV = {
  KINTONE_BASE_URL: BASE_URL,
  KINTONE_USERNAME: "taro",
  KINTONE_PASSWORD: "secret",
};

const OAUTH_ENV = {
  KINTONE_BASE_URL: BASE_URL,
  KINTONE_OAUTH_CLIENT_ID: "id",
  KINTONE_OAUTH_CLIENT_SECRET: "secret",
  KINTONE_OAUTH_REDIRECT_URI: "https://app.example.com/cb",
  KINTONE_OAUTH_AUTHORIZATION_ENDPOINT: `${BASE_URL}/oauth2/authorization`,
  KINTONE_OAUTH_TOKEN_ENDPOINT: `${BASE_URL}/oauth2/token`,
};

describe("設定の読み取り", () => {
  it("ログイン名とパスワードがあればパスワード認証になる", () => {
    const config = loadKintoneConfig(PASSWORD_ENV);
    expect(config.auth).toEqual({ kind: "password", username: "taro", password: "secret" });
  });

  it("OAuth の設定があれば OAuth になる", () => {
    expect(loadKintoneConfig(OAUTH_ENV).auth.kind).toBe("oauth");
  });

  it("両方あればパスワード認証を使う", () => {
    expect(loadKintoneConfig({ ...OAUTH_ENV, ...PASSWORD_ENV }).auth.kind).toBe("password");
  });

  it("KINTONE_AUTH で明示的に選べる", () => {
    const env = { ...OAUTH_ENV, ...PASSWORD_ENV, KINTONE_AUTH: "oauth" };
    expect(loadKintoneConfig(env).auth.kind).toBe("oauth");
  });

  it("KINTONE_AUTH に知らない値を書いたら弾く", () => {
    expect(() => loadKintoneConfig({ ...PASSWORD_ENV, KINTONE_AUTH: "apiToken" })).toThrow(
      /"password" か "oauth"/,
    );
  });

  it("どちらも無ければ、両方の選択肢を示して弾く", () => {
    const error = (() => {
      try {
        loadKintoneConfig({ KINTONE_BASE_URL: BASE_URL });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("エラーになりませんでした");
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/KINTONE_USERNAME/);
    expect(error.message).toMatch(/KINTONE_OAUTH_CLIENT_ID/);
  });

  it("パスワードだけ書き忘れたら、足りないものを名指しする", () => {
    const env = { KINTONE_BASE_URL: BASE_URL, KINTONE_USERNAME: "taro", KINTONE_AUTH: "password" };
    expect(() => loadKintoneConfig(env)).toThrow(/KINTONE_PASSWORD/);
  });

  it("baseUrl が無ければ弾く", () => {
    expect(() => loadKintoneConfig({ KINTONE_USERNAME: "a", KINTONE_PASSWORD: "b" })).toThrow(
      /KINTONE_BASE_URL/,
    );
  });

  it("末尾のスラッシュを落とす", () => {
    expect(loadKintoneConfig({ ...PASSWORD_ENV, KINTONE_BASE_URL: `${BASE_URL}/` }).baseUrl).toBe(
      BASE_URL,
    );
  });
});

describe("requireOAuth", () => {
  it("OAuth なら取り出せる", () => {
    expect(requireOAuth(loadKintoneConfig(OAUTH_ENV)).clientId).toBe("id");
  });

  it("パスワード認証のときは、認可が不要であることを伝える", () => {
    const error = (() => {
      try {
        requireOAuth(loadKintoneConfig(PASSWORD_ENV));
      } catch (e) {
        return e as Error;
      }
      throw new Error("エラーになりませんでした");
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/認可の手続きは要りません/);
  });
});

describe("パスワード認証のクライアント", () => {
  const config: KintoneConfig = {
    baseUrl: BASE_URL,
    auth: { kind: "password", username: "taro", password: "secret" },
  };

  it("トークンが無くても使える (login が要らない)", () => {
    // OAuth と違い、保存済みトークンもスコープの検査も無い。
    const env: NodeJS.ProcessEnv = { FIELDSMITH_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fieldsmith-pw-")) };
    expect(() => createAuthenticatedKintone({ config, env })).not.toThrow();
    rmSync(env["FIELDSMITH_CONFIG_DIR"]!, { recursive: true, force: true });
  });

  it("X-Cybozu-Authorization で認証する", async () => {
    const { server, mock } = setupKintoneMock();
    server.listen({ onUnhandledRequest: "error" });

    const spec = parseAppSpec({
      name: "案件管理",
      layout: "stacked",
      space: "12",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "案件名" }],
    });
    await deployAppSpec(spec, createAuthenticatedKintone({ config }), {
      spaceId: "12",
      polling: { initialDelayMs: 0, maxDelayMs: 0, sleep: noSleep },
    });
    server.close();

    // スペース指定は REST API を直接叩く経路なので、認証ヘッダーの差し替えが効いているか分かる。
    const header = mock.headersOf("app")?.["x-cybozu-authorization"];
    expect(header).toBe(Buffer.from("taro:secret").toString("base64"));
  });

  it("401 なら認証情報そのものを疑うよう伝える", async () => {
    const { server } = setupKintoneMock({ failOnce: { path: "app", status: 401 } });
    server.listen({ onUnhandledRequest: "error" });

    const spec = parseAppSpec({
      name: "案件管理",
      layout: "stacked",
      fields: [{ type: "SINGLE_LINE_TEXT", label: "案件名" }],
    });
    const error = await deployAppSpec(spec, createAuthenticatedKintone({ config }), {
      polling: { initialDelayMs: 0, maxDelayMs: 0, sleep: noSleep },
    })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    server.close();

    // 更新できるトークンが無いので、再試行せず原因を示す。
    expect(error!.message).toMatch(/KINTONE_USERNAME と KINTONE_PASSWORD/);
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(ReauthRequiredError);
  });
});
