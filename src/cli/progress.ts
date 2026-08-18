/**
 * 待ち時間の見える化。
 *
 * 生成もデプロイも数十秒かかることがあり、無言のまま待たされるのは
 * 「止まっているのか動いているのか分からない」という一番不安な状態になる。
 * TTY では 1 行を書き換え続け、パイプやリダイレクト先では普通の行として出す。
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 行頭に戻って行全体を消す (カーソル移動 + 行クリア)。 */
const CLEAR_LINE = "\r[2K";

export interface StatusLine {
  /** 表示中の文言を差し替える。 */
  update(text: string): void;
  /** 履歴として残る行を出す。ステータス行はその下に描き直す。 */
  log(line: string): void;
  /** 行を確定させて次へ進む。 */
  done(final?: string): void;
  /** 経過秒数。 */
  elapsedSeconds(): number;
}

export interface StatusLineOptions {
  readonly stream?: NodeJS.WriteStream;
  readonly isTty?: boolean;
  /** テストから時間を固定するためのフック。 */
  readonly now?: () => number;
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

export function startStatusLine(initial: string, options: StatusLineOptions = {}): StatusLine {
  const stream = options.stream ?? process.stderr;
  const isTty = options.isTty ?? stream.isTTY === true;
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setIntervalImpl ?? setInterval;
  const clearIntervalFn = options.clearIntervalImpl ?? clearInterval;

  const startedAt = now();
  let text = initial;
  let frame = 0;
  let finished = false;

  const elapsedSeconds = (): number => Math.floor((now() - startedAt) / 1000);

  const render = (): void => {
    if (finished) return;
    stream.write(`${CLEAR_LINE}${FRAMES[frame % FRAMES.length]} ${text} (${elapsedSeconds()}秒)`);
    frame += 1;
  };

  // TTY でなければアニメーションは意味を成さないので、更新のたびに 1 行出すだけにする。
  const timer = isTty ? setIntervalFn(render, 100) : null;
  timer?.unref?.();

  if (isTty) {
    render();
  } else {
    stream.write(`${initial}\n`);
  }

  return {
    update(next: string): void {
      if (finished || next === text) return;
      text = next;
      if (isTty) {
        render();
      } else {
        stream.write(`${next}\n`);
      }
    },
    log(line: string): void {
      if (isTty) {
        // ステータス行を消してから履歴行を出し、直後に描き直す。
        stream.write(CLEAR_LINE);
        stream.write(`${line}\n`);
        render();
      } else {
        stream.write(`${line}\n`);
      }
    },
    done(final?: string): void {
      if (finished) return;
      finished = true;
      if (timer !== null) clearIntervalFn(timer);
      if (isTty) {
        stream.write(CLEAR_LINE);
      }
      if (final !== undefined) {
        stream.write(`${final}\n`);
      }
    },
    elapsedSeconds,
  };
}

/**
 * 思考の要約は改行を含む長文なので、1 行のステータスに収まる形へ畳む。
 * 末尾を残すのは「いま何を考えているか」が見たいため。
 */
export function tailLine(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return `…${flat.slice(flat.length - maxLength)}`;
}
