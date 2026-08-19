import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KintoneRestAPIError } from "@kintone/rest-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KintoneConfig } from "../src/config.js";
import { ConfigError, loadKintoneConfig } from "../src/config.js";
import { createAuthenticatedKintone, DEFAULT_SOCKET_TIMEOUT_MS } from "../src/kintone/client.js";
import {
  buildAuthorizationRequest,
  exchangeAuthorizationCode,
  extractAuthorizationCode,
  OAuthError,
  missingScopes,
  ReauthRequiredError,
  refreshAccessToken,
  REQUIRED_SCOPE,
  REQUIRED_SCOPES,
} from "../src/kintone/oauth.js";
import { clearToken, isExpired, loadToken, saveToken, tokenFilePath } from "../src/kintone/tokenStore.js";

const oauth = {
  kind: "oauth" as const,
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://app.example.com/oauth/callback",
  authorizationEndpoint: "https://example.cybozu.com/oauth2/authorization",
  tokenEndpoint: "https://example.cybozu.com/oauth2/token",
};
const oauthConfig = { baseUrl: "https://example.cybozu.com", ...oauth };
const config: KintoneConfig = { baseUrl: "https://example.cybozu.com", auth: oauth };

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = { VCK_CONFIG_DIR: mkdtempSync(join(tmpdir(), "vck-oauth-")) };
});

afterEach(() => {
  rmSync(env["VCK_CONFIG_DIR"]!, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("必要なスコープ", () => {
  /**
   * 書き込み系がすべて通ったあと、反映状況の確認 (GET) だけが 403 CB_OA01 になる
   * という形で表面化したことがある。read が要ることを固定しておく。
   */
  it("設定の読み書きとファイル書き込みを要求する", () => {
    expect([...REQUIRED_SCOPES]).toEqual([
      "k:app_settings:read",
      "k:app_settings:write",
      "k:file:write",
    ]);
    expect(REQUIRED_SCOPE).toBe("k:app_settings:read k:app_settings:write k:file:write");
  });

  it("付与済みスコープから不足分を割り出す", () => {
    expect(missingScopes(REQUIRED_SCOPE)).toEqual([]);
    // read を忘れると反映状況の確認だけが 403 になる。
    expect(missingScopes("k:app_settings:write k:file:write")).toEqual(["k:app_settings:read"]);
    // file:write を忘れるとアイコンのアップロードだけが落ちる。
    expect(missingScopes("k:app_settings:read k:app_settings:write")).toEqual(["k:file:write"]);
    expect(missingScopes("k:app_record:read")).toEqual([...REQUIRED_SCOPES]);
  });

  it("scope が不明なときは判定しない (古いトークンを無効化しない)", () => {
    expect(missingScopes(undefined)).toEqual([]);
    expect(missingScopes("")).toEqual([]);
  });
});

describe("認可 URL", () => {
  it("必要なスコープと state を含む", () => {
    const { url, state } = buildAuthorizationRequest(oauthConfig);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe(REQUIRED_SCOPE);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe(oauthConfig.redirectUri);
    expect(parsed.searchParams.get("state")).toBe(state);
    expect(state.length).toBeGreaterThan(20);
  });

  it("呼ぶたびに異なる state を生成する", () => {
    expect(buildAuthorizationRequest(oauthConfig).state).not.toBe(buildAuthorizationRequest(oauthConfig).state);
  });
});

describe("認可コードの取り出し", () => {
  it("code を取り出す", () => {
    const url = "https://app.example.com/oauth/callback?code=abc123&state=s1";
    expect(extractAuthorizationCode(url, "s1")).toBe("abc123");
  });

  it("state が一致しなければ中断する", () => {
    const url = "https://app.example.com/oauth/callback?code=abc123&state=other";
    expect(() => extractAuthorizationCode(url, "s1")).toThrow(/state が一致しません/);
  });

  it("state が無ければ中断する", () => {
    const url = "https://app.example.com/oauth/callback?code=abc123";
    expect(() => extractAuthorizationCode(url, "s1")).toThrow(OAuthError);
  });

  it("認可が拒否された場合はその旨を伝える", () => {
    const url = "https://app.example.com/oauth/callback?error=access_denied&state=s1";
    expect(() => extractAuthorizationCode(url, "s1")).toThrow(/認可が拒否されました/);
  });

  it("URL でない入力を分かりやすく弾く", () => {
    expect(() => extractAuthorizationCode("abc123", "s1")).toThrow(/URL として解釈できません/);
  });

  it("前後の空白は許容する", () => {
    const url = "  https://app.example.com/oauth/callback?code=abc&state=s1\n";
    expect(extractAuthorizationCode(url, "s1")).toBe("abc");
  });
});

describe("トークン交換", () => {
  it("Basic 認証ヘッダーと form-urlencoded で要求する", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    );

    const token = await exchangeAuthorizationCode(oauthConfig, "code-1", fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(oauthConfig.tokenEndpoint);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("redirect_uri")).toBe(oauthConfig.redirectUri);

    expect(token.accessToken).toBe("at");
    expect(token.refreshToken).toBe("rt");
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it("expires_in が無ければ 1 時間として扱う", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "at", refresh_token: "rt" }));
    const token = await exchangeAuthorizationCode(oauthConfig, "c", fetchImpl as unknown as typeof fetch);
    expect(token.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("refresh_token が返らなければ失敗させる", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "at" }));
    await expect(
      exchangeAuthorizationCode(oauthConfig, "c", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/リフレッシュトークンが返されませんでした/);
  });

  it("HTTP エラーの本文を添えて失敗させる", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid_grant", { status: 400 }));
    await expect(
      exchangeAuthorizationCode(oauthConfig, "c", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 400[\s\S]*invalid_grant/);
  });
});

describe("トークン更新", () => {
  it("refresh_token グラントで更新する", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "new", expires_in: 3600 }));
    const token = await refreshAccessToken(oauthConfig, "rt", fetchImpl as unknown as typeof fetch);

    const body = new URLSearchParams((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt");
    // ローテーションされない実装のため、返らなければ元の値を保持する。
    expect(token.refreshToken).toBe("rt");
    expect(token.accessToken).toBe("new");
  });

  it("新しい refresh_token が返ればそれを使う", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "new", refresh_token: "rt2" }));
    const token = await refreshAccessToken(oauthConfig, "rt", fetchImpl as unknown as typeof fetch);
    expect(token.refreshToken).toBe("rt2");
  });

  it("更新に失敗したら再ログインを促す", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid_grant", { status: 400 }));
    const error = await refreshAccessToken(oauthConfig, "rt", fetchImpl as unknown as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect((error as Error).message).toMatch(/vck login/);
  });
});

describe("トークンストア", () => {
  const token = { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000 };

  it("保存と読み出しができる", () => {
    saveToken(config.baseUrl, token, env);
    expect(loadToken(config.baseUrl, env)).toEqual(token);
  });

  it("ファイルを 0600 で作る", () => {
    saveToken(config.baseUrl, token, env);
    const mode = statSync(tokenFilePath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("baseUrl ごとに別々に保持する", () => {
    saveToken("https://a.cybozu.com", token, env);
    saveToken("https://b.cybozu.com", { ...token, accessToken: "other" }, env);
    expect(loadToken("https://a.cybozu.com", env)!.accessToken).toBe("at");
    expect(loadToken("https://b.cybozu.com", env)!.accessToken).toBe("other");
  });

  it("末尾スラッシュや大文字小文字の違いを吸収する", () => {
    saveToken("https://Example.cybozu.com/", token, env);
    expect(loadToken("https://example.cybozu.com", env)).toEqual(token);
  });

  it("未保存なら null を返す", () => {
    expect(loadToken(config.baseUrl, env)).toBeNull();
  });

  it("破棄できる", () => {
    saveToken(config.baseUrl, token, env);
    expect(clearToken(config.baseUrl, env)).toBe(true);
    expect(loadToken(config.baseUrl, env)).toBeNull();
    expect(clearToken(config.baseUrl, env)).toBe(false);
  });

  it("失効の 60 秒前から期限切れ扱いにする", () => {
    const now = 1_000_000;
    expect(isExpired({ ...token, expiresAt: now + 61_000 }, now)).toBe(false);
    expect(isExpired({ ...token, expiresAt: now + 59_000 }, now)).toBe(true);
  });
});

describe("認証済みクライアント", () => {
  it("トークンが無ければ再ログインを促す", () => {
    expect(() => createAuthenticatedKintone({ config, env })).toThrow(ReauthRequiredError);
  });

  it("スコープが足りないトークンでは、API を呼ぶ前に再ログインを促す", () => {
    saveToken(
      config.baseUrl,
      {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 3600_000,
        scope: "k:app_settings:write",
      },
      env,
    );

    // ここで止めないと「アプリだけ作られて途中で 403」という最悪の形になる。
    expect(() => createAuthenticatedKintone({ config, env })).toThrow(/k:app_settings:read/);
    expect(() => createAuthenticatedKintone({ config, env })).toThrow(/vck login/);
  });

  it("scope が記録されていないトークンは通す (判定材料が無いため)", () => {
    saveToken(
      config.baseUrl,
      { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000 },
      env,
    );
    expect(() => createAuthenticatedKintone({ config, env, clientFactory: () => ({}) as never })).not.toThrow();
  });

  it("期限切れなら呼び出し前に更新して保存する", async () => {
    saveToken(config.baseUrl, { accessToken: "old", refreshToken: "rt", expiresAt: 0 }, env);
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "fresh", expires_in: 3600 }));

    const tokens: string[] = [];
    const kintone = createAuthenticatedKintone({
      config,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clientFactory: (accessToken) => {
        tokens.push(accessToken);
        return {} as never;
      },
    });

    await kintone.call(async () => "ok");
    expect(tokens).toEqual(["fresh"]);
    expect(loadToken(config.baseUrl, env)!.accessToken).toBe("fresh");
  });

  it("401 を受けたら更新して 1 回だけ再実行する", async () => {
    saveToken(config.baseUrl, { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 3600_000 }, env);
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "fresh", expires_in: 3600 }));

    const kintone = createAuthenticatedKintone({
      config,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clientFactory: (accessToken) => ({ token: accessToken }) as never,
    });

    let attempts = 0;
    const result = await kintone.call(async (client) => {
      attempts += 1;
      if (attempts === 1) throw unauthorizedError();
      return (client as unknown as { token: string }).token;
    });

    expect(attempts).toBe(2);
    expect(result).toBe("fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("再実行しても 401 なら諦める (無限ループさせない)", async () => {
    saveToken(config.baseUrl, { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 3600_000 }, env);
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "fresh", expires_in: 3600 }));

    const kintone = createAuthenticatedKintone({
      config,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clientFactory: () => ({}) as never,
    });

    let attempts = 0;
    await expect(
      kintone.call(async () => {
        attempts += 1;
        throw unauthorizedError();
      }),
    ).rejects.toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("既定で 1 リクエストの上限時間を設定する (無限に待たない)", () => {
    saveToken(
      config.baseUrl,
      { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000, scope: REQUIRED_SCOPE },
      env,
    );

    // 既定では socketTimeout が未設定で、応答が返らないと CLI が黙って止まる。
    expect(DEFAULT_SOCKET_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_SOCKET_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("401 以外はそのまま投げる", async () => {
    saveToken(config.baseUrl, { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000 }, env);
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "fresh" }));

    const kintone = createAuthenticatedKintone({
      config,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clientFactory: () => ({}) as never,
    });

    await expect(kintone.call(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("設定の読み込み", () => {
  const full = {
    KINTONE_BASE_URL: "https://example.cybozu.com/",
    KINTONE_OAUTH_CLIENT_ID: "id",
    KINTONE_OAUTH_CLIENT_SECRET: "secret",
    KINTONE_OAUTH_REDIRECT_URI: "https://app.example.com/cb",
    KINTONE_OAUTH_AUTHORIZATION_ENDPOINT: "https://example.cybozu.com/oauth2/authorization",
    KINTONE_OAUTH_TOKEN_ENDPOINT: "https://example.cybozu.com/oauth2/token",
  };

  it("末尾スラッシュを落として読み込む", () => {
    expect(loadKintoneConfig(full).baseUrl).toBe("https://example.cybozu.com");
  });

  it("足りない環境変数をまとめて列挙する", () => {
    const error = (() => {
      try {
        loadKintoneConfig({ KINTONE_BASE_URL: full.KINTONE_BASE_URL });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("エラーになりませんでした");
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/KINTONE_OAUTH_CLIENT_ID/);
    expect(error.message).toMatch(/KINTONE_OAUTH_TOKEN_ENDPOINT/);
  });

  it("URL として不正な値を弾く", () => {
    expect(() => loadKintoneConfig({ ...full, KINTONE_BASE_URL: "example.cybozu.com" })).toThrow(
      /KINTONE_BASE_URL/,
    );
  });
});

function unauthorizedError(): Error {
  return new KintoneRestAPIError({
    status: 401,
    statusText: "Unauthorized",
    headers: {},
    data: { id: "x", code: "GAIA_NO01", message: "認証エラー" },
  });
}
