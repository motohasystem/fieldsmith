/**
 * 終了コードと、失敗の分類。
 *
 * AI エージェントから呼ばれることを想定している。
 * すべて 1 で返すと「AppSpec を直す」のか「login する」のか「再試行する」のかが
 * 判別できず、次の一手を決められない。分類して返す。
 */

export const EXIT = {
  /** 成功。 */
  ok: 0,
  /** 想定外のエラー。 */
  unknown: 1,
  /** AppSpec が不正。→ AppSpec を直して再実行する。 */
  validation: 2,
  /** kintone の認証・認可の問題。→ `vck login` を実行する。 */
  auth: 3,
  /** 環境変数などの設定不足。→ .env を直す。 */
  config: 4,
  /** kintone API 側のエラー。→ 権限を確認するか、時間をおいて再試行する。 */
  kintone: 5,
  /** AppSpec の生成に失敗。→ 要件の書き方を変えて再実行する。 */
  generation: 6,
  /** コマンドの入力が不正 (ファイルが無い、引数の指定ミスなど)。 */
  input: 7,
} as const;

export type ExitName = keyof typeof EXIT;

/** 失敗の分類ごとの、次にとるべき行動。--json と --help で示す。 */
export const EXIT_HINT: Readonly<Record<ExitName, string>> = {
  ok: "成功",
  unknown: "想定外のエラー。メッセージを確認する",
  validation: "AppSpec を直して再実行する",
  auth: "`vck login` で認可をやり直す",
  config: ".env の設定を見直す",
  kintone: "kintone 側の権限を確認するか、時間をおいて再試行する",
  generation: "要件の書き方を変えて再実行する",
  input: "コマンドの引数を見直す",
};
