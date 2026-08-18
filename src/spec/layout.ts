/**
 * フォームレイアウトの組み立て。
 *
 * kintone にフィールドを追加すると、既定では 1 行に 1 つずつ縦に並ぶ。
 * 似た性質のフィールドを横に並べたほうが、記入する人にとって見通しが良い。
 *
 * まとめ方の基準は 2 段構え。
 *   1. フィールドに `group` (「書誌情報」「貸出」など意味のまとまり) があればそれを使う
 *   2. 無ければフィールド型の系統で代用する
 *
 * `group` は意味の判断が要るので、`plan` / `create` ではモデルが付ける。
 * デプロイ層は付いた結果を使うだけで、判断はしない。
 *
 * どちらの場合も **並び順は変えない**ので、AppSpec に書いた順序の意図は保たれる。
 */

/** レイアウト上のフィールド 1 つ。 */
export interface LayoutField {
  readonly type: string;
  readonly code: string;
}

/** フィールドコード → 意味のまとまりの名前。 */
export type FieldGroups = Readonly<Record<string, string>>;

/** kintone のレイアウトの 1 要素。ROW 以外 (GROUP / SUBTABLE) はそのまま通す。 */
export type LayoutRow =
  | { readonly type: "ROW"; readonly fields: LayoutField[] }
  | { readonly type: string; readonly [key: string]: unknown };

/**
 * フィールドの系統。同じ系統どうしだけを横に並べる。
 * ここに無い型 (複数行テキスト、リッチエディター、添付ファイルなど) は
 * 幅を取るか背が高くなるため、常に単独行にする。
 */
const FIELD_FAMILY: Readonly<Record<string, string>> = {
  SINGLE_LINE_TEXT: "テキスト",
  LINK: "テキスト",

  NUMBER: "数値",
  CALC: "数値",

  DROP_DOWN: "選択",
  RADIO_BUTTON: "選択",
  CHECK_BOX: "選択",
  MULTI_SELECT: "選択",

  DATE: "日時",
  TIME: "日時",
  DATETIME: "日時",

  USER_SELECT: "ユーザー",
  ORGANIZATION_SELECT: "ユーザー",
  GROUP_SELECT: "ユーザー",

  RECORD_NUMBER: "自動項目",
  CREATOR: "自動項目",
  MODIFIER: "自動項目",
  CREATED_TIME: "自動項目",
  UPDATED_TIME: "自動項目",
};

/** 1 行にまとめられる上限の既定値。 */
export const DEFAULT_MAX_PER_ROW = 3;

/** そのフィールドが属する系統。単独行にすべきものは null。 */
export function familyOf(type: string): string | null {
  return FIELD_FAMILY[type] ?? null;
}

export interface GroupOptions {
  /** 1 行に並べる上限。 */
  readonly maxPerRow?: number;
  /** フィールドコードごとの意味のまとまり。指定があれば系統より優先する。 */
  readonly groups?: FieldGroups;
}

/**
 * そのフィールドをまとめる基準。単独行にすべきものは null。
 *
 * 幅や高さを取る型は、意味のまとまりがあっても横に並べない
 * (見た目の制約は意味とは別の話なので)。
 */
export function groupKeyOf(field: LayoutField, groups: FieldGroups = {}): string | null {
  const family = familyOf(field.type);
  if (family === null) return null;

  const group = groups[field.code];
  return group === undefined || group === "" ? family : `group:${group}`;
}

/**
 * フィールドの並びを、系統ごとに最大 maxPerRow 個までの行にまとめる。
 *
 * 並び順は保つ。系統が変わったところ、単独行にすべき型が来たところ、
 * 上限に達したところで行を切る。
 */
export function groupIntoRows(
  fields: readonly LayoutField[],
  options: GroupOptions = {},
): LayoutField[][] {
  const maxPerRow = Math.max(1, options.maxPerRow ?? DEFAULT_MAX_PER_ROW);
  const rows: LayoutField[][] = [];

  let current: LayoutField[] = [];
  let currentFamily: string | null = null;

  const flush = (): void => {
    if (current.length > 0) rows.push(current);
    current = [];
    currentFamily = null;
  };

  for (const field of fields) {
    const key = groupKeyOf(field, options.groups);

    // 単独行にすべき型は、前後と混ぜずにそれだけの行にする。
    if (key === null) {
      flush();
      rows.push([field]);
      continue;
    }

    if (key !== currentFamily || current.length >= maxPerRow) {
      flush();
      currentFamily = key;
    }
    current.push(field);
  }
  flush();

  return rows;
}

/**
 * kintone から取得した既存のレイアウトを並べ替える。
 *
 * GROUP と SUBTABLE の行はそのまま残す (中身の構造が別なので触らない)。
 * 連続する ROW だけをいったん平らにして、系統ごとにまとめ直す。
 */
export function regroupLayout(
  layout: readonly LayoutRow[],
  options: GroupOptions = {},
): LayoutRow[] {
  const result: LayoutRow[] = [];
  let pending: LayoutField[] = [];

  const flushPending = (): void => {
    for (const row of groupIntoRows(pending, options)) {
      result.push({ type: "ROW", fields: row });
    }
    pending = [];
  };

  for (const row of layout) {
    if (row.type === "ROW") {
      const fields = (row as { fields?: unknown }).fields;
      if (Array.isArray(fields)) {
        pending.push(...(fields as LayoutField[]));
      }
      continue;
    }
    // GROUP / SUBTABLE の前後で行の連続は途切れる。
    flushPending();
    result.push(row);
  }
  flushPending();

  return result;
}

/** 並べ替えの結果を人が読める形にする (--dry-run と進捗表示で使う)。 */
export function describeRows(rows: readonly (readonly LayoutField[])[]): string[] {
  return rows.map((row) => row.map((field) => field.code).join(" | "));
}

/**
 * 削除候補グループのフィールドコード。
 * 毎回同じコードを使うことで、更新を繰り返してもグループが増えない。
 */
export const ORPHAN_GROUP_CODE = "_削除候補";
export const ORPHAN_GROUP_LABEL = "削除候補";

/** レイアウトから、そのフィールドコードを取り除く。空になった行は落とす。 */
function withoutFields(layout: readonly LayoutRow[], remove: ReadonlySet<string>): LayoutRow[] {
  const result: LayoutRow[] = [];
  for (const row of layout) {
    if (row.type === "ROW") {
      const fields = ((row as { fields?: LayoutField[] }).fields ?? []).filter(
        (field) => !remove.has(field.code),
      );
      if (fields.length > 0) result.push({ type: "ROW", fields });
      continue;
    }
    if (row.type === "GROUP") {
      const nested = withoutFields(
        ((row as { layout?: LayoutRow[] }).layout ?? []) as LayoutRow[],
        remove,
      );
      result.push({ ...(row as Record<string, unknown>), type: "GROUP", layout: nested } as LayoutRow);
      continue;
    }
    result.push(row);
  }
  return result;
}

/** レイアウトに載っているフィールドを、入れ子も含めて集める。 */
export function collectLayoutFields(layout: readonly LayoutRow[]): LayoutField[] {
  const fields: LayoutField[] = [];
  for (const row of layout) {
    const own = (row as { fields?: LayoutField[] }).fields;
    if (row.type === "ROW" && Array.isArray(own)) fields.push(...own);
    const nested = (row as { layout?: LayoutRow[] }).layout;
    if (Array.isArray(nested)) fields.push(...collectLayoutFields(nested));
  }
  return fields;
}

export interface UpdatedLayoutInput {
  /** kintone から取得した現在のレイアウト。 */
  readonly current: readonly LayoutRow[];
  /** 目標の並び。regroup が true のときだけ使う。 */
  readonly desired: readonly LayoutField[];
  /** 削除候補に送るフィールドコード。 */
  readonly orphans: readonly string[];
  /** 並びを組み直すか。false なら既存の行に手を触れない。 */
  readonly regroup: boolean;
  readonly maxPerRow?: number;
  readonly groups?: FieldGroups;
}

/**
 * 更新後のフォームレイアウトを組み立てる。
 *
 * レイアウト変更 API は「フォーム上のすべてのフィールド」の指定を求めるので、
 * 現在のレイアウトを起点に、載せ替えと退避を行う。
 *
 * 削除候補のフィールドは**消さずに**、畳んだグループへ移す。
 * 逆に、削除候補グループの中にあったフィールドが目標に戻ってきたら、外に出す。
 */
export function buildUpdatedLayout(input: UpdatedLayoutInput): LayoutRow[] {
  const orphans = new Set(input.orphans);
  const desiredCodes = new Set(input.desired.map((field) => field.code));

  // 既存の削除候補グループの中身を把握する。目標に戻ったものは外へ出す。
  const existingGroup = input.current.find(
    (row) => row.type === "GROUP" && (row as { code?: string }).code === ORPHAN_GROUP_CODE,
  );
  const parked = existingGroup === undefined
    ? []
    : collectLayoutFields(((existingGroup as { layout?: LayoutRow[] }).layout ?? []) as LayoutRow[]);
  const revived = parked.filter((field) => desiredCodes.has(field.code));

  // 型が分かるように、退避するフィールドの情報を現在のレイアウトから拾っておく。
  const known = new Map(collectLayoutFields(input.current).map((field) => [field.code, field]));

  // 削除候補グループと、そこへ入るもの・戻るものを、いったん全部どかす。
  const removed = new Set([...orphans, ...parked.map((field) => field.code)]);
  let base = withoutFields(
    input.current.filter(
      (row) => !(row.type === "GROUP" && (row as { code?: string }).code === ORPHAN_GROUP_CODE),
    ),
    removed,
  );

  if (input.regroup) {
    // ROW は目標の並びで作り直す。GROUP / SUBTABLE はそのまま残す。
    const others = base.filter((row) => row.type !== "ROW");
    const rows = groupIntoRows(
      input.desired.filter((field) => !orphans.has(field.code)),
      {
        ...(input.maxPerRow === undefined ? {} : { maxPerRow: input.maxPerRow }),
        ...(input.groups === undefined ? {} : { groups: input.groups }),
      },
    ).map((row): LayoutRow => ({ type: "ROW", fields: row }));
    base = [...rows, ...others];
  } else {
    // 手を触れない場合でも、戻ってきたフィールドは行として足す必要がある。
    base = [...base, ...revived.map((field): LayoutRow => ({ type: "ROW", fields: [field] }))];
  }

  const parkedNow = [...orphans].map(
    (code): LayoutField => known.get(code) ?? { code, type: "SINGLE_LINE_TEXT" },
  );
  if (parkedNow.length === 0) return base;

  return [
    ...base,
    {
      type: "GROUP",
      code: ORPHAN_GROUP_CODE,
      layout: parkedNow.map((field): LayoutRow => ({ type: "ROW", fields: [field] })),
    } as LayoutRow,
  ];
}
