import { KintoneRestAPIClient, KintoneRestAPIError } from "@kintone/rest-api-client";
import type { KintoneConfig } from "../config.js";
import { requireOAuth } from "../config.js";
import { missingScopes, ReauthRequiredError, refreshAccessToken } from "./oauth.js";
import { isExpired, loadToken, saveToken, type StoredToken } from "./tokenStore.js";

/** 認証済みの kintone クライアント。トークンの失効を意識せずに使える。 */
export interface AuthenticatedKintone {
  /**
   * kintone API を 1 回呼ぶ。
   * 401 が返った場合はアクセストークンを更新して 1 度だけ再実行する。
   */
  call<T>(operation: (client: KintoneRestAPIClient) => Promise<T>): Promise<T>;

  /**
   * REST API を直接叩く。
   * `@kintone/rest-api-client` が内部で OAuth 非対応の API を呼んでしまう場合に使う
   * (アプリ作成でスペースを指定する経路など)。call() と同じトークン管理に乗る。
   */
  request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T>;
}

/** kintone が返すエラー応答。 */
export class KintoneRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "KintoneRequestError";
  }
}

/**
 * kintone への 1 リクエストの上限時間。
 * 既定では無制限で、応答が返らないと CLI が黙って止まったままになる。
 */
export const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;

export interface CreateClientOptions {
  readonly config: KintoneConfig;
  readonly guestSpaceId?: number | string;
  /** 1 リクエストの上限時間 (ミリ秒)。 */
  readonly socketTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  /** テストから差し替えるためのフック。既定では実物の KintoneRestAPIClient を作る。 */
  readonly clientFactory?: (accessToken: string) => KintoneRestAPIClient;
}

/**
 * 保存済みの OAuth トークンで kintone クライアントを組み立てる。
 * アクセストークンは 1 時間で失効する一方リフレッシュトークンは無期限なので、
 * 事前チェックと 401 リトライの二段構えで再ログインをほぼ不要にする。
 */
export function createAuthenticatedKintone(options: CreateClientOptions): AuthenticatedKintone {
  return options.config.auth.kind === "password"
    ? createWithPassword(options)
    : createWithOAuth(options);
}

/**
 * パスワード認証のクライアント。
 *
 * 資格情報が固定なので、トークンの保存も更新もスコープの検査も要らない。
 * 401 が返ったら、それは認証情報そのものが正しくないということ。
 */
function createWithPassword(options: CreateClientOptions): AuthenticatedKintone {
  const { config } = options;
  const auth = config.auth as Extract<KintoneConfig["auth"], { kind: "password" }>;
  const fetchImpl = options.fetchImpl ?? fetch;

  const client =
    options.clientFactory?.("") ??
    new KintoneRestAPIClient({
      baseUrl: config.baseUrl,
      auth: { username: auth.username, password: auth.password },
      ...(options.guestSpaceId === undefined ? {} : { guestSpaceId: options.guestSpaceId }),
      socketTimeout: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
      userAgent: USER_AGENT,
    });

  const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");

  return {
    async call<T>(operation: (client: KintoneRestAPIClient) => Promise<T>): Promise<T> {
      try {
        return await operation(client);
      } catch (error) {
        if (isUnauthorized(error)) {
          throw new ReauthRequiredError(
            `${config.baseUrl} の認証に失敗しました。` +
              " KINTONE_USERNAME と KINTONE_PASSWORD を確認してください。",
          );
        }
        throw error;
      }
    },

    async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
      return await rawRequest<T>(
        { "X-Cybozu-Authorization": credentials },
        config.baseUrl,
        method,
        path,
        body,
        options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
        fetchImpl,
      );
    },
  };
}

/**
 * OAuth のクライアント。
 *
 * アクセストークンは 1 時間で失効する一方リフレッシュトークンは無期限なので、
 * 事前チェックと 401 リトライの二段構えで再ログインをほぼ不要にする。
 */
function createWithOAuth(options: CreateClientOptions): AuthenticatedKintone {
  const { config, env = process.env, fetchImpl = fetch } = options;
  const oauth = requireOAuth(config);

  const stored = loadToken(config.baseUrl, env);
  if (stored === null) {
    throw new ReauthRequiredError(
      `${config.baseUrl} の認証情報が見つかりません。\`vck login\` を実行してください。`,
    );
  }

  // スコープ不足は途中まで成功してから 403 で落ちるという最悪の形で表面化する
  // (アプリだけ作られて残る)。1 リクエストも投げる前に気付けるようにする。
  const missing = missingScopes(stored.scope);
  if (missing.length > 0) {
    throw new ReauthRequiredError(
      `保存済みの認証情報にスコープ ${missing.join(", ")} が含まれていません。\n` +
        "`vck login` を実行して認可をやり直してください。",
    );
  }

  let token: StoredToken = stored;

  const factory =
    options.clientFactory ??
    ((accessToken: string) =>
      new KintoneRestAPIClient({
        baseUrl: config.baseUrl,
        auth: { oAuthToken: accessToken },
        ...(options.guestSpaceId === undefined ? {} : { guestSpaceId: options.guestSpaceId }),
        socketTimeout: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
        userAgent: USER_AGENT,
      }));

  const refresh = async (): Promise<void> => {
    token = await refreshAccessToken(oauth, token.refreshToken, fetchImpl);
    saveToken(config.baseUrl, token, env);
  };

  return {
    async call<T>(operation: (client: KintoneRestAPIClient) => Promise<T>): Promise<T> {
      if (isExpired(token)) {
        await refresh();
      }

      try {
        return await operation(factory(token.accessToken));
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        // 期限内でも失効しているケース (トークン失効・スコープ変更など) がある。
        await refresh();
        return await operation(factory(token.accessToken));
      }
    },

    async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
      if (isExpired(token)) {
        await refresh();
      }

      const send = (): Promise<T> =>
        rawRequest<T>(
          { Authorization: `Bearer ${token.accessToken}` },
          config.baseUrl,
          method,
          path,
          body,
          options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
          fetchImpl,
        );

      try {
        return await send();
      } catch (error) {
        if (!(error instanceof KintoneRequestError) || error.status !== 401) throw error;
        await refresh();
        return await send();
      }
    },
  };
}

const USER_AGENT = "vck (vibe-crafting-kintone)";

/** 認証ヘッダーだけを差し替えて REST API を直接叩く。 */
async function rawRequest<T>(
  authHeaders: Record<string, string>,
  baseUrl: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: { ...authHeaders, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);

  if (!response.ok) {
    throw new KintoneRequestError(
      typeof parsed["message"] === "string" ? parsed["message"] : `HTTP ${response.status}`,
      response.status,
      typeof parsed["code"] === "string" ? parsed["code"] : undefined,
    );
  }
  return parsed as T;
}

/** ゲストスペースかどうかで API のパスの前置きが変わる。 */
export function apiPathPrefix(guestSpaceId?: number | string): string {
  return guestSpaceId === undefined ? "/k/v1" : `/k/guest/${guestSpaceId}/v1`;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof KintoneRestAPIError && error.status === 401;
}
