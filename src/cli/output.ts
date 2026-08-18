import { EXIT, EXIT_HINT, type ExitName } from "./exit.js";

/**
 * 出力の振り分け。
 *
 * `--json` を付けると、**stdout には機械可読な JSON だけ**が出て、
 * 人間向けの文言と進捗はすべて stderr に回る。
 * AI エージェントは stdout をそのまま JSON.parse できる。
 */

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * 人間向けの 1 行。
 * 既定では stdout、`--json` のときは stdout を汚さないよう stderr に出す。
 */
export function say(line = ""): void {
  const stream = jsonMode ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/** 機械向けの出力先。`--json` のときだけ使う。 */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export interface SuccessResult {
  readonly command: string;
  readonly [key: string]: unknown;
}

/** 成功結果。`--json` のときだけ出力する。 */
export function emitSuccess(result: SuccessResult): void {
  if (!jsonMode) return;
  emitJson({ ok: true, ...result });
}

export interface FailureDetail {
  readonly command: string;
  readonly kind: ExitName;
  readonly message: string;
  /** AppSpec の検証エラーの内訳など。 */
  readonly issues?: readonly { path: string; message: string }[];
  /** 途中まで進んでいた場合に、作られたアプリの ID。 */
  readonly appId?: string | null;
}

/**
 * 失敗を報告して終了コードを立てる。
 * `--json` なら機械可読で、そうでなければ従来どおり人が読める形で出す。
 */
export function emitFailure(detail: FailureDetail): void {
  process.exitCode = EXIT[detail.kind];

  if (jsonMode) {
    emitJson({
      ok: false,
      command: detail.command,
      error: {
        kind: detail.kind,
        exitCode: EXIT[detail.kind],
        // 次に何をすればよいかを、判断せずに読み取れるようにする。
        hint: EXIT_HINT[detail.kind],
        message: detail.message,
        ...(detail.issues === undefined ? {} : { issues: detail.issues }),
        ...(detail.appId === undefined || detail.appId === null ? {} : { appId: detail.appId }),
      },
    });
    return;
  }

  console.error(detail.message);
  for (const issue of detail.issues ?? []) {
    console.error(`  ${issue.path}: ${issue.message}`);
  }
}
