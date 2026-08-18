import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * kintone への接続と OAuth クライアントの設定。
 * 認可・トークンの各エンドポイント URL は cybozu.com 共通管理で OAuth クライアントを
 * 登録したときに払い出される値なので、ハードコードせず設定から読む。
 */
export const kintoneConfigSchema = z.object({
  baseUrl: z.string().url("KINTONE_BASE_URL は URL 形式で指定してください"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url("KINTONE_OAUTH_REDIRECT_URI は URL 形式で指定してください"),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
});

export type KintoneConfig = z.infer<typeof kintoneConfigSchema>;

const ENV_KEYS = {
  baseUrl: "KINTONE_BASE_URL",
  clientId: "KINTONE_OAUTH_CLIENT_ID",
  clientSecret: "KINTONE_OAUTH_CLIENT_SECRET",
  redirectUri: "KINTONE_OAUTH_REDIRECT_URI",
  authorizationEndpoint: "KINTONE_OAUTH_AUTHORIZATION_ENDPOINT",
  tokenEndpoint: "KINTONE_OAUTH_TOKEN_ENDPOINT",
} as const satisfies Record<keyof KintoneConfig, string>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 環境変数から kintone の設定を読む。
 * 足りない環境変数は名前を列挙して伝える (1 つずつ試行錯誤させないため)。
 */
export function loadKintoneConfig(env: NodeJS.ProcessEnv = process.env): KintoneConfig {
  const raw: Record<string, string | undefined> = {};
  const missing: string[] = [];

  for (const [key, envKey] of Object.entries(ENV_KEYS)) {
    const value = env[envKey];
    if (value === undefined || value.trim() === "") {
      missing.push(envKey);
    } else {
      raw[key] = value.trim();
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `次の環境変数が設定されていません:\n  ${missing.join("\n  ")}\n` +
        ".env.example を参考に .env を作成してください。",
    );
  }

  const result = kintoneConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${ENV_KEYS[issue.path[0] as keyof KintoneConfig] ?? issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`環境変数の値が不正です:\n${details}`);
  }

  // 末尾のスラッシュは kintone のクライアントが URL を組み立てるときに二重化するので落とす。
  return { ...result.data, baseUrl: result.data.baseUrl.replace(/\/+$/, "") };
}

/**
 * .env をプロセス環境に読み込む。
 * dotenv を足すほどの要件ではないため、`KEY=VALUE` 形式だけを素直に解釈する。
 * すでに設定済みの環境変数は上書きしない (CI での注入を優先するため)。
 */
export function loadDotEnv(path = ".env", env: NodeJS.ProcessEnv = process.env): void {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return;
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
}
