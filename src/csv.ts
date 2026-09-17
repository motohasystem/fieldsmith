/**
 * CSV の読み取り。
 *
 * cli-kintone が読み書きする形に合わせる。依存を増やさずに済む程度の仕様なので自前で持つ。
 *
 * **引用符の中の改行を扱えることが必須。** チェックボックスや複数選択の値は
 * 1 つのセルの中に改行区切りで入るため、行単位で切ると壊れる。
 * @see https://cli.kintone.dev/guide/formats/csv/
 */

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/** CSV を行の配列に切り分ける。空行は落とす。 */
export function parseCsv(text: string): string[][] {
  // BOM は値の一部ではない。付いたままだと先頭列のフィールドコードが一致しなくなる。
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;

  const endCell = (): void => {
    row.push(cell);
    cell = "";
    started = false;
  };
  const endRow = (): void => {
    endCell();
    // 空行 (セル 1 つで中身なし) は読み飛ばす。末尾の改行で毎回作られるため。
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;

    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      // "" は引用符そのもの。それ以外は引用の終わり。
      if (source[i + 1] === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ",") {
      endCell();
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      endRow();
      continue;
    }
    cell += char;
    started = true;
  }

  if (quoted) {
    throw new CsvError("引用符が閉じられていません。CSV の末尾を確認してください。");
  }
  if (cell !== "" || row.length > 0) endRow();

  return rows;
}

/** cli-kintone がレコードの先頭行に付ける印。テーブルを含むときだけ現れる。 */
export const PRIMARY_MARK_COLUMN = "*";

/** CSV の 1 行。行番号は 1 始まり (ヘッダーが 1 行目)。 */
export interface CsvRow {
  readonly line: number;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * レコード 1 件。
 *
 * テーブルがある CSV では、1 件が複数行にまたがる。
 * テーブルの外の値は先頭行にだけ書かれ、ほかの行のものは kintone 側で無視される。
 */
export interface CsvRecord {
  readonly line: number;
  /** テーブルの外のフィールド。先頭行の値。 */
  readonly values: Readonly<Record<string, string>>;
  /** テーブルの行。先頭行も含む。テーブルが無い CSV でも 1 行だけ入る。 */
  readonly rows: readonly CsvRow[];
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly records: readonly CsvRecord[];
}

/**
 * 切り分けた CSV を、レコードの列に組み直す。
 *
 * `*` 列があれば、印の付いた行から次の印までを 1 件とみなす。
 * 無ければ 1 行が 1 件。
 */
export function toCsvTable(rows: readonly string[][]): CsvTable {
  const [header, ...body] = rows;
  if (header === undefined) {
    throw new CsvError("CSV が空です。1 行目にフィールドコードが要ります。");
  }

  const duplicated = header.filter((name, index) => name !== "" && header.indexOf(name) !== index);
  if (duplicated.length > 0) {
    throw new CsvError(`CSV の見出しに同じ列が 2 つ以上あります: ${[...new Set(duplicated)].join(", ")}`);
  }

  const hasPrimaryMark = header.includes(PRIMARY_MARK_COLUMN);
  const toValues = (cells: readonly string[]): Record<string, string> => {
    const values: Record<string, string> = {};
    header.forEach((name, index) => {
      if (name !== "" && name !== PRIMARY_MARK_COLUMN) values[name] = cells[index] ?? "";
    });
    return values;
  };

  const records: CsvRecord[] = [];
  body.forEach((cells, index) => {
    const line = index + 2;
    const row: CsvRow = { line, values: toValues(cells) };

    const starts =
      !hasPrimaryMark || cells[header.indexOf(PRIMARY_MARK_COLUMN)]?.trim() === PRIMARY_MARK_COLUMN;
    const previous = records[records.length - 1];
    if (starts || previous === undefined) {
      records.push({ line, values: row.values, rows: [row] });
      return;
    }
    // 続きの行。テーブルの外の値は先頭行のものが効くので、行だけ足す。
    (previous.rows as CsvRow[]).push(row);
  });

  return { header, records };
}
