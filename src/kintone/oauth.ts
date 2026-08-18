import { randomBytes } from "node:crypto";
import type { KintoneConfig } from "../config.js";
import type { StoredToken } from "./tokenStore.js";

/**
 * 必要な OAuth スコープ。
 *
 * 書き込み系 (アプリ作成・フィールド追加・一覧/一般設定の変更・運用環境への反映) は
 * `k:app_settings:write` に収まるが、**反映状況の確認 (GET /k/v1/preview/app/deploy.json) は
 * 読み取りなので `k:app_settings:read` が要る**。
 * write だけだと、デプロイまで成功したあとの状況確認で 403 (CB_OA01) になる。
 *
 * アプリアイコンを設定する場合は画像をアップロードするので `k:file:write` も要る。
 * レコードには触れないので、レコード系のスコープは要求しない。
 */
export const REQUIRED_SCOPES = [
  "k:app_settings:read",
  "k:app_settings:write",
  // アプリアイコンの画像をアップロードする (POST /k/v1/file.json) ために要る。
  "k:file:write",
] as const;

/** 認可リクエストに載せるスコープ文字列 (OAuth の仕様どおり空白区切り)。 */
export const REQUIRED_SCOPE = REQUIRED_SCOPES.join(" ");

/**
 * 付与済みのスコープのうち、足りないものを返す。
 * kintone がトークン応答で scope を返さない場合は判定できないので空配列を返す。
 */
export function missingScopes(granted: string | undefined): string[] {
  if (granted === undefined || granted.trim() === "") return [];
  const set = new Set(granted.split(/\s+/));
  return REQUIRED_SCOPES.filter((scope) => !set.has(scope));
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail === undefined ? message : `${message}\n${detail}`);
    this.name = "OAuthError";
  }
}

/** 再ログインが必要な状態。CLI 側でこれを見て `vck login` を案内する。 */
export class ReauthRequiredError extends OAuthError {
  constructor(message: string, detail?: string) {
    super(message, detail);
    this.name = "ReauthRequiredError";
  }
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
}

/** 認可 URL と、リダイレクト後に照合するための state を生成する。 */
export function buildAuthorizationRequest(config: KintoneConfig): AuthorizationRequest {
  const state = randomBytes(24).toString("base64url");
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", REQUIRED_SCOPE);
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

/**
 * リダイレクト先の URL から認可コードを取り出す。
 * state が一致しない場合は CSRF の可能性があるので必ず中断する。
 */
export function extractAuthorizationCode(redirectedUrl: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(redirectedUrl.trim());
  } catch {
    throw new OAuthError(
      "リダイレクト先の URL として解釈できませんでした。ブラウザのアドレスバーの内容をそのまま貼り付けてください。",
    );
  }

  const error = url.searchParams.get("error");
  if (error !== null) {
    throw new OAuthError(
      "認可が拒否されました。",
      `error=${error} ${url.searchParams.get("error_description") ?? ""}`.trim(),
    );
  }

  const state = url.searchParams.get("state");
  if (state !== expectedState) {
    throw new OAuthError(
      "state が一致しません。認可をやり直してください。",
      `期待値と異なる state が返されました (受信: ${state ?? "なし"})`,
    );
  }

  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    throw new OAuthError("URL に認可コード (code) が含まれていません。");
  }
  return code;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
}

/** 認可コードをアクセストークン・リフレッシュトークンに交換する。 */
export async function exchangeAuthorizationCode(
  config: KintoneConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });
  const response = await requestToken(config, body, fetchImpl);

  if (response.refresh_token === undefined) {
    throw new OAuthError(
      "リフレッシュトークンが返されませんでした。OAuth クライアントの設定を確認してください。",
    );
  }
  return toStoredToken(response, response.refresh_token);
}

/**
 * リフレッシュトークンでアクセストークンを更新する。
 * kintone のリフレッシュトークンには有効期限が無いため、通常はこの経路だけで動き続ける。
 */
export async function refreshAccessToken(
  config: KintoneConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  let response: TokenResponse;
  try {
    response = await requestToken(config, body, fetchImpl);
  } catch (error) {
    if (error instanceof OAuthError) {
      throw new ReauthRequiredError(
        "アクセストークンの更新に失敗しました。`vck login` で認可をやり直してください。",
        error.detail,
      );
    }
    throw error;
  }

  // リフレッシュトークンがローテーションされない実装もあるため、返らなければ元の値を使い続ける。
  return toStoredToken(response, response.refresh_token ?? refreshToken);
}

async function requestToken(
  config: KintoneConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  const response = await fetchImpl(config.tokenEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new OAuthError(
      `トークンエンドポイントがエラーを返しました (HTTP ${response.status})`,
      text.slice(0, 500),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OAuthError("トークンエンドポイントの応答を JSON として解釈できませんでした", text.slice(0, 500));
  }

  const accessToken = (parsed as TokenResponse | null)?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new OAuthError("トークンエンドポイントの応答に access_token が含まれていません", text.slice(0, 500));
  }
  return parsed as TokenResponse;
}

function toStoredToken(response: TokenResponse, refreshToken: string): StoredToken {
  // kintone のアクセストークンは 1 時間。expires_in が返らない場合もその想定で扱う。
  const expiresInSeconds = response.expires_in ?? 3600;
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    ...(response.scope === undefined ? {} : { scope: response.scope }),
  };
}
