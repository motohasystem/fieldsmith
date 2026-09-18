import { BUILT_IN_FIELD_CODES, resolveFieldCode, type AppSpec } from "./appSpec.js";
import { isOptionFieldType, type FieldSpec } from "./fieldSpec.js";
import { PRIMARY_MARK_COLUMN, type CsvRecord, type CsvTable } from "../csv.js";

/**
 * 投入するデータが AppSpec に収まるかを、kintone に投げる前に確かめる。
 *
 * `deploy --dry-run` が「spec が正しいか」を接続せずに見るのと同じ立ち位置で、
 * こちらは「**データがその spec に入るか**」を見る。
 *
 * kintone のレコード追加 API は 100 件のかたまり単位で失敗するので、
 * 1 件の違反が 100 件の取りこぼしになる。投入してから気づくと被害が桁で増える。
 */

export type CheckIssueKind =
  | "required"
  | "duplicate"
  | "option"
  | "number"
  | "range"
  | "length"
  | "date"
  | "missingColumn"
  | "extraColumn"
  | "ignoredColumn";

export interface CheckSample {
  /** CSV の行番号 (ヘッダーを 1 行目とする)。 */
  readonly line: number;
  /** その行を見分けるための値。タイトルフィールドなどから取る。 */
  readonly id: string;
  readonly value: string;
}

export interface CheckIssue {
  readonly kind: CheckIssueKind;
  /** error は投入時に失敗する。warning は通るが、意図と違うかもしれない。 */
  readonly severity: "error" | "warning";
  readonly field: string;
  readonly message: string;
  readonly count: number;
  readonly samples: readonly CheckSample[];
}

export interface CheckResult {
  readonly records: number;
  readonly columns: number;
  readonly issues: readonly CheckIssue[];
  readonly errors: number;
  readonly warnings: number;
}

/** 1 つの違反につき見せる例の数。全部出すと 260 件が流れてしまう。 */
const MAX_SAMPLES = 3;

/** 複数値のフィールドは、1 つのセルに改行区切りで入る。 */
const MULTI_VALUE_TYPES = new Set([
  "CHECK_BOX",
  "MULTI_SELECT",
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT",
]);

export function checkRecords(spec: AppSpec, table: CsvTable): CheckResult {
  const issues: CheckIssue[] = [];
  const columns = new Set(table.header.filter((name) => name !== "" && name !== PRIMARY_MARK_COLUMN));
  const identify = identifier(spec, columns);

  for (const field of spec.fields) {
    const code = resolveFieldCode(field);
    if (!columns.has(code)) {
      issues.push({
        kind: "missingColumn",
        severity: "warning",
        field: code,
        message: "spec にありますが CSV に列がありません (空で登録されます)",
        count: 0,
        samples: [],
      });
      continue;
    }
    issues.push(...checkField(field, code, table, identify));
  }

  const known = new Set(spec.fields.map(resolveFieldCode));
  for (const column of columns) {
    if (known.has(column)) continue;
    const builtIn = BUILT_IN_FIELD_CODES.has(column);
    issues.push({
      kind: builtIn ? "ignoredColumn" : "extraColumn",
      severity: "warning",
      field: column,
      message: builtIn
        ? "kintone が自動で付けるフィールドなので、投入しても無視されます"
        : "CSV にありますが spec にありません (無視されます)",
      count: 0,
      samples: [],
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  return {
    records: table.records.length,
    columns: columns.size,
    issues,
    errors,
    warnings: issues.length - errors,
  };
}

/** そのフィールドについて、全レコードを見て違反を集める。 */
function checkField(
  field: FieldSpec,
  code: string,
  table: CsvTable,
  identify: (record: CsvRecord) => string,
): CheckIssue[] {
  const collected = new Map<CheckIssueKind, { message: string; samples: CheckSample[]; count: number }>();
  const add = (kind: CheckIssueKind, message: string, sample: CheckSample): void => {
    const entry = collected.get(kind) ?? { message, samples: [], count: 0 };
    entry.count += 1;
    if (entry.samples.length < MAX_SAMPLES) entry.samples.push(sample);
    // 最大値などを含むメッセージは、より極端なものに置き換える。
    entry.message = message;
    collected.set(kind, entry);
  };

  const seen = new Map<string, number>();

  for (const record of table.records) {
    // テーブルの列はレコード内の全行を、それ以外は先頭行だけを見る。
    const rows = field.table === undefined ? [record.rows[0]!] : record.rows;
    const id = identify(record);

    for (const row of rows) {
      const raw = row.values[code] ?? "";
      const sample: CheckSample = { line: row.line, id, value: raw };

      if (raw === "") {
        if (field.required === true) {
          add("required", "必須ですが空の値があります", sample);
        }
        continue;
      }

      if (field.unique === true) {
        const first = seen.get(raw);
        if (first !== undefined) {
          add("duplicate", `重複を禁止していますが、同じ値があります (最初は ${first} 行目)`, sample);
        } else {
          seen.set(raw, row.line);
        }
      }

      for (const [kind, message] of violations(field, raw)) add(kind, message, sample);
    }
  }

  return [...collected].map(([kind, entry]) => ({
    kind,
    severity: "error" as const,
    field: code,
    message: entry.message,
    count: entry.count,
    samples: entry.samples,
  }));
}

/** 1 つの値が、そのフィールドの制約に反していないか。 */
function violations(field: FieldSpec, raw: string): [CheckIssueKind, string][] {
  const found: [CheckIssueKind, string][] = [];
  const values = MULTI_VALUE_TYPES.has(field.type) ? raw.split("\n").filter((v) => v !== "") : [raw];

  if (isOptionFieldType(field.type) && "options" in field) {
    const allowed = field.options;
    const options = new Set(allowed);
    for (const value of values) {
      if (!options.has(value)) {
        found.push(["option", `選択肢にない値があります (選択肢: ${allowed.join(" / ")})`]);
        break;
      }
    }
  }

  if (field.type === "NUMBER") {
    const parsed = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
      found.push(["number", "数値として読めない値があります"]);
    } else {
      const min = toNumber(field.minValue);
      const max = toNumber(field.maxValue);
      if (min !== undefined && parsed < min) {
        found.push(["range", `minValue ${min} を下回る値があります`]);
      }
      if (max !== undefined && parsed > max) {
        found.push(["range", `maxValue ${max} を超える値があります`]);
      }
    }
  }

  const maxLength = "maxLength" in field ? field.maxLength : undefined;
  const minLength = "minLength" in field ? field.minLength : undefined;
  const length = [...raw].length;
  if (maxLength !== undefined && length > maxLength) {
    found.push(["length", `maxLength ${maxLength} を超える値があります (最長 ${length} 文字)`]);
  }
  if (minLength !== undefined && length < minLength) {
    found.push(["length", `minLength ${minLength} に満たない値があります`]);
  }

  if (!readsAsDate(field.type, raw)) {
    found.push(["date", `${field.type} として読めない値があります`]);
  }

  return found;
}

/**
 * 日付・時刻として読めるか。
 *
 * 判定に迷うものは通す。**取りこぼすより誤検出のほうが困る**ので、
 * 明らかに読めないものだけを拾う。
 */
function readsAsDate(type: string, raw: string): boolean {
  if (type === "DATE") return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(raw);
  if (type === "TIME") return /^\d{1,2}:\d{2}(:\d{2})?$/.test(raw);
  if (type === "DATETIME") return !Number.isNaN(Date.parse(raw));
  return true;
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 違反した行を人が見分けるための値を取る。
 *
 * 行番号だけでは元データのどこを直せばよいか分からない。
 * タイトルにするフィールド、無ければ重複を禁止しているフィールドを使う。
 */
function identifier(spec: AppSpec, columns: ReadonlySet<string>): (record: CsvRecord) => string {
  const candidates = [
    spec.settings?.titleFieldCode,
    ...spec.fields.filter((field) => field.unique === true).map(resolveFieldCode),
    ...spec.fields.filter((field) => field.table === undefined).map(resolveFieldCode),
  ];
  const code = candidates.find((name) => name !== undefined && columns.has(name));
  if (code === undefined) return () => "";
  return (record) => {
    const value = record.values[code];
    return value === undefined || value === "" ? "" : `${code}=${value}`;
  };
}
