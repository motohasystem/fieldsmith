import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const storedTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** アクセストークンの失効時刻 (エポックミリ秒)。 */
  expiresAt: z.number().int().nonnegative(),
  scope: z.string().optional(),
});

export type StoredToken = z.infer<typeof storedTokenSchema>;

/** baseUrl をキーに複数の kintone ドメインのトークンを保持する。 */
const tokenFileSchema = z.object({
  version: z.literal(1),
  tokens: z.record(z.string(), storedTokenSchema),
});

/**
 * トークンの保存先。
 * `FIELDSMITH_CONFIG_DIR` で上書きできるようにしてあるのは、テストと、
 * 複数の kintone 環境を切り替えて使う場合のため。
 */
export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["FIELDSMITH_CONFIG_DIR"] ?? join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "fieldsmith");
  return join(base, "tokens.json");
}

function readTokenFile(path: string): z.infer<typeof tokenFileSchema> {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { version: 1, tokens: {} };
  }

  const result = tokenFileSchema.safeParse(safeJsonParse(content));
  if (!result.success) {
    // 壊れたファイルで動けなくなるより、再ログインを促すほうが復旧が早い。
    return { version: 1, tokens: {} };
  }
  return result.data;
}

export function loadToken(baseUrl: string, env: NodeJS.ProcessEnv = process.env): StoredToken | null {
  const file = readTokenFile(tokenFilePath(env));
  return file.tokens[normalizeBaseUrl(baseUrl)] ?? null;
}

/** トークンを保存する。ファイルはパーミッション 0600 で作成する。 */
export function saveToken(
  baseUrl: string,
  token: StoredToken,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = tokenFilePath(env);
  const file = readTokenFile(path);
  file.tokens[normalizeBaseUrl(baseUrl)] = token;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  // 既存ファイルへの上書きでは writeFileSync の mode が効かないため明示的に設定する。
  chmodSync(path, 0o600);
}

/** 保存済みトークンを破棄する。対象が無ければ false を返す。 */
export function clearToken(baseUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = tokenFilePath(env);
  const file = readTokenFile(path);
  const key = normalizeBaseUrl(baseUrl);
  if (!(key in file.tokens)) return false;

  delete file.tokens[key];
  if (Object.keys(file.tokens).length === 0) {
    rmSync(path, { force: true });
  } else {
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return true;
}

/** 失効まで残り 60 秒を切っていれば期限切れとみなす (通信中の失効を避けるため)。 */
export function isExpired(token: StoredToken, now = Date.now()): boolean {
  return token.expiresAt - 60_000 <= now;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").toLowerCase();
}

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
