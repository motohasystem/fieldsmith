import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * kintone への接続設定。
 *
 * 認証は 2 通り選べる。
 *   - **パスワード認証**: ログイン名とパスワードだけ。事前の登録が要らない
 *   - **OAuth**: 事前に OAuth クライアントを登録するが、パスワードを保存しない
 *
 * どちらでもアプリの作成・更新に必要な API は使える。
 * 認可・トークンの各エンドポイント URL は OAuth クライアントの登録時に払い出される値なので、
 * ハードコードせず設定から読む。
 */

/** パスワード認証。`X-Cybozu-Authorization` ヘッダーで送る。 */
export interface PasswordAuth {
  readonly kind: "password";
  readonly username: string;
  readonly password: string;
}

/** OAuth 2.0。アクセストークンを取得して `Authorization: Bearer` で送る。 */
export interface OAuthAuth {
  readonly kind: "oauth";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export type KintoneAuth = PasswordAuth | OAuthAuth;

export interface KintoneConfig {
  readonly baseUrl: string;
  readonly auth: KintoneAuth;
}

/** OAuth 固有の処理に渡す形。 */
export type OAuthConfig = { readonly baseUrl: string } & OAuthAuth;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const BASE_URL_KEY = "KINTONE_BASE_URL";

const PASSWORD_KEYS = {
  username: "KINTONE_USERNAME",
  password: "KINTONE_PASSWORD",
} as const;

const OAUTH_KEYS = {
  clientId: "KINTONE_OAUTH_CLIENT_ID",
  clientSecret: "KINTONE_OAUTH_CLIENT_SECRET",
  redirectUri: "KINTONE_OAUTH_REDIRECT_URI",
  authorizationEndpoint: "KINTONE_OAUTH_AUTHORIZATION_ENDPOINT",
  tokenEndpoint: "KINTONE_OAUTH_TOKEN_ENDPOINT",
} as const;

const oauthSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(`${OAUTH_KEYS.redirectUri} は URL 形式で指定してください`),
  authorizationEndpoint: z.string().url(`${OAUTH_KEYS.authorizationEndpoint} は URL 形式で指定してください`),
  tokenEndpoint: z.string().url(`${OAUTH_KEYS.tokenEndpoint} は URL 形式で指定してください`),
});

const passwordSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * 環境変数から接続設定を読む。
 *
 * どちらの認証方式を使うかは、設定されている環境変数から判断する。
 * 両方揃っている場合はパスワード認証を使う (`KINTONE_AUTH` で明示的に選べる)。
 */
export function loadKintoneConfig(env: NodeJS.ProcessEnv = process.env): KintoneConfig {
  const baseUrl = read(env, BASE_URL_KEY);
  if (baseUrl === undefined) {
    throw new ConfigError(
      `${BASE_URL_KEY} が設定されていません。\n` + ".env.example を参考に .env を作成してください。",
    );
  }
  if (!z.string().url().safeParse(baseUrl).success) {
    throw new ConfigError(`${BASE_URL_KEY} は URL 形式で指定してください (例: https://example.cybozu.com)`);
  }

  const requested = read(env, "KINTONE_AUTH");
  if (requested !== undefined && requested !== "password" && requested !== "oauth") {
    throw new ConfigError('KINTONE_AUTH には "password" か "oauth" を指定してください。');
  }

  const hasPassword = Object.values(PASSWORD_KEYS).every((key) => read(env, key) !== undefined);
  const hasOAuth = Object.values(OAUTH_KEYS).some((key) => read(env, key) !== undefined);
  const kind = requested ?? (hasPassword ? "password" : hasOAuth ? "oauth" : undefined);

  if (kind === undefined) {
    throw new ConfigError(
      "kintone の認証情報が設定されていません。どちらかを設定してください。\n" +
        `  パスワード認証: ${Object.values(PASSWORD_KEYS).join(", ")}\n` +
        `  OAuth        : ${Object.values(OAUTH_KEYS).join(", ")}\n` +
        ".env.example を参考に .env を作成してください。",
    );
  }

  return {
    // 末尾のスラッシュは URL を組み立てるときに二重化するので落とす。
    baseUrl: baseUrl.replace(/\/+$/, ""),
    auth: kind === "password" ? readPassword(env) : readOAuth(env),
  };
}

function readPassword(env: NodeJS.ProcessEnv): PasswordAuth {
  const raw = collect(env, PASSWORD_KEYS, "パスワード認証");
  const result = passwordSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(describeIssues(result.error, PASSWORD_KEYS));
  }
  return { kind: "password", ...result.data };
}

function readOAuth(env: NodeJS.ProcessEnv): OAuthAuth {
  const raw = collect(env, OAUTH_KEYS, "OAuth");
  const result = oauthSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(describeIssues(result.error, OAUTH_KEYS));
  }
  return { kind: "oauth", ...result.data };
}

/** 足りない環境変数は名前を列挙して伝える (1 つずつ試行錯誤させないため)。 */
function collect(
  env: NodeJS.ProcessEnv,
  keys: Readonly<Record<string, string>>,
  label: string,
): Record<string, string> {
  const raw: Record<string, string> = {};
  const missing: string[] = [];

  for (const [field, key] of Object.entries(keys)) {
    const value = read(env, key);
    if (value === undefined) missing.push(key);
    else raw[field] = value;
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `${label}に必要な環境変数が設定されていません:\n  ${missing.join("\n  ")}`,
    );
  }
  return raw;
}

function describeIssues(error: z.ZodError, keys: Readonly<Record<string, string>>): string {
  const details = error.issues
    .map((issue) => `  ${keys[String(issue.path[0])] ?? issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  return `環境変数の値が不正です:\n${details}`;
}

function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/**
 * OAuth 固有の処理に渡す形にする。
 * パスワード認証で設定されている場合は、その旨を伝えて止める。
 */
export function requireOAuth(config: KintoneConfig): OAuthConfig {
  if (config.auth.kind !== "oauth") {
    throw new ConfigError(
      "この操作は OAuth を設定しているときだけ使えます。\n" +
        "  いまはパスワード認証で設定されています。認可の手続きは要りません。",
    );
  }
  return { baseUrl: config.baseUrl, ...config.auth };
}

/**
 * 認証情報を書いたファイルの置き場所を、探す順に返す。
 *
 * cwd だけを見ていると、案件のディレクトリから叩くたびに
 * `node --env-file=...` を書くことになる。かといって上へ遡ると、
 * どれを読んだのか分からなくなる。**明示 → cwd → 設定ディレクトリ**の 3 つに絞る。
 */
export function dotEnvCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const configDir =
    env["FIELDSMITH_CONFIG_DIR"] ??
    join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "fieldsmith");

  return [
    // 明示指定。どれを読むかを完全に決めたいとき。
    env["FIELDSMITH_ENV"],
    // リポジトリ直下で作業しているとき。これまでの挙動。
    ".env",
    // どのディレクトリから叩いても効く置き場所。
    join(configDir, "default.env"),
  ].filter((path): path is string => path !== undefined && path !== "");
}

/**
 * .env をプロセス環境に読み込む。**最初に見つかった 1 つだけを読む。**
 * 複数を重ねると、どの値がどこから来たのか追えなくなる。
 *
 * dotenv を足すほどの要件ではないため、`KEY=VALUE` 形式だけを素直に解釈する。
 * すでに設定済みの環境変数は上書きしない (CI での注入を優先するため)。
 *
 * 読んだファイルのパスを返す。どれも無ければ null。
 */
export function loadDotEnv(
  paths: readonly string[] = dotEnvCandidates(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const path of paths) {
    if (readDotEnvFile(path, env)) return path;
  }
  return null;
}

function readDotEnvFile(path: string, env: NodeJS.ProcessEnv): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return false;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key === "" || env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return true;
}
