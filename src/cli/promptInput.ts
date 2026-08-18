import { readFileSync } from "node:fs";

/**
 * プロンプトの入力元を解決する。
 *
 * 要件が長くなると、シェルの引数として渡すのは現実的でなくなる
 * (改行、引用符、全角括弧のエスケープ)。ファイルか標準入力から読めるようにする。
 */

export class PromptInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptInputError";
  }
}

/** 読み込んだプロンプトが長すぎないかを知らせるための目安。 */
export const LARGE_PROMPT_CHARS = 20_000;

export interface ResolvePromptOptions {
  /** 引数として渡されたプロンプト。 */
  readonly argument?: string | undefined;
  /** --prompt-file で指定されたパス。`-` は標準入力。 */
  readonly filePath?: string | undefined;
  /** テストから差し替えるためのフック。 */
  readonly readFile?: (path: string) => string;
  readonly readStdin?: () => string;
}

export interface ResolvedPrompt {
  readonly text: string;
  /** どこから読んだか。表示に使う。 */
  readonly source: string;
}

/**
 * 引数とファイル指定から、実際に使うプロンプトを決める。
 * 両方指定・どちらも無しは、黙ってどちらかを採用せずエラーにする
 * (意図と違うほうが使われるのが一番困るため)。
 */
export function resolvePrompt(options: ResolvePromptOptions): ResolvedPrompt {
  const { argument, filePath } = options;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const readStdin = options.readStdin ?? (() => readFileSync(0, "utf-8"));

  const hasArgument = argument !== undefined && argument.trim() !== "";

  if (hasArgument && filePath !== undefined) {
    throw new PromptInputError(
      "プロンプトの指定が重複しています。引数か --prompt-file のどちらか一方にしてください。",
    );
  }

  if (filePath !== undefined) {
    const fromStdin = filePath === "-";
    let content: string;
    try {
      content = fromStdin ? readStdin() : readFile(filePath);
    } catch (error) {
      throw new PromptInputError(
        fromStdin
          ? `標準入力を読み込めませんでした: ${messageOf(error)}`
          : `プロンプトのファイルを読み込めませんでした: ${filePath}`,
      );
    }

    const text = content.trim();
    if (text === "") {
      throw new PromptInputError(
        fromStdin ? "標準入力が空です。" : `${filePath} が空です。`,
      );
    }
    return { text, source: fromStdin ? "標準入力" : filePath };
  }

  if (!hasArgument) {
    throw new PromptInputError(
      "作りたいアプリの説明を指定してください。\n" +
        "  引数で渡す:       vck plan \"案件管理アプリ。案件名、顧客名、金額\"\n" +
        "  ファイルから読む: vck plan --prompt-file requirements.md\n" +
        "  標準入力から読む: cat requirements.md | vck plan --prompt-file -",
    );
  }

  return { text: argument.trim(), source: "コマンドライン引数" };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
