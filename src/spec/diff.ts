import {
  appliesLayout,
  fieldGroups,
  fieldTables,
  resolveFieldCode,
  resolveLayout,
  type AppSpec,
  type ViewSpec,
} from "./appSpec.js";
import { tableCodeOf } from "./layout.js";
import type { FieldSpec } from "./fieldSpec.js";

/**
 * 既存アプリと目標の AppSpec を突き合わせて、何をすべきかを求める。
 *
 * **差分は決定的なコードで計算する。** LLM に「追加・変更・削除のリスト」を書かせると、
 * 消し忘れや取り違えが起きる。LLM には「望ましい最終形」だけを書かせ、
 * そこから何をするかはここで導出する。
 *
 * 同一性の鍵は**フィールドコード**。コードが変われば別のフィールドとして扱う。
 */

/** 1 つの設定項目の変化。 */
export interface Change {
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
}

export interface FieldAddition {
  readonly code: string;
  readonly field: FieldSpec;
}

export interface FieldUpdate {
  readonly code: string;
  readonly field: FieldSpec;
  readonly changes: readonly Change[];
}

/**
 * 型を変えようとしているフィールド。
 * kintone は作成後の型を変更できないので、**そのままでは実現できない**。
 */
export interface FieldRetype {
  readonly code: string;
  readonly from: string;
  readonly to: string;
}

/**
 * 目標の AppSpec に無くなったフィールド。
 * **削除はしない。** データが消えるので、削除候補として畳んだグループに移すだけにする。
 */
export interface FieldOrphan {
  readonly code: string;
  readonly type: string;
  readonly label: string;
}

/**
 * テーブルに関わる変更。
 *
 * **`update` では適用しない。** kintone のテーブルには列の退避先が無く
 * (SUBTABLE のレイアウトは行を持たない平らな配列)、列を外に出すのは作り直しになる。
 * fieldsmith の「消さずに削除候補へ移す」が成り立たないので、
 * 黙って一部だけ適用せず、まとめて止める。
 */
export interface TableChange {
  readonly code: string;
  readonly table: string;
  readonly kind: "added" | "updated" | "removed" | "moved";
}

export interface ViewDiff {
  readonly added: readonly ViewSpec[];
  readonly updated: readonly { name: string; view: ViewSpec; changes: readonly Change[] }[];
  readonly removed: readonly string[];
}

/**
 * フォームの並びの変化。
 *
 * フィールドの並び順・group・layout の指定は、個々のフィールド設定には現れない。
 * 拾わないと「並べ替えたのに差分なしと言われる」ことになるので、独立して見る。
 */
export interface LayoutDiff {
  /** 表示上の指定 (例: "stacked" → "grouped (最大 3 列)")。 */
  readonly from: string;
  readonly to: string;
  readonly modeChanged: boolean;
  /** 両方に在るフィールドの並び順が変わったか。 */
  readonly orderChanged: boolean;
  /** group の割り当てが変わったか。 */
  readonly groupsChanged: boolean;
  /**
   * フィールドの顔ぶれが変わったか (`sections` のときだけ見る)。
   *
   * 増えたフィールドは、レイアウトを書かないと kintone がフォーム末尾に置く。
   * セクションを使っているときは**所属先の外**に出てしまうので、
   * 顔ぶれが変わったこと自体を組み直す理由として扱う。
   */
  readonly membersChanged: boolean;
  /**
   * 実際にレイアウトを組み直すか。
   * 目標が `stacked` の場合は既存の並びに手を触れないので、変化があっても適用しない。
   */
  readonly willApply: boolean;
}

/**
 * spec から外したのに kintone 側に残る設定を拾う。
 *
 * 「書かれていない項目は現状維持」という仕様どおりだが、**キーを消す＝設定を外す**と
 * 読むほうが自然で、しかも差分に出ないので「差分なし＝変わっていない」と読めてしまう。
 * 変更としては扱わず、外し方を添えて警告にする。
 *
 * 外し方を示せるものだけを対象にする (真偽値なら `false`、それ以外は空文字)。
 * テーマやタイトルフィールドのように「空にする」書き方が無いものは黙って見送る。
 */
function staleSettings(
  label: string,
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
  keep?: ReadonlySet<string>,
): string[] {
  const warnings: string[] = [];

  for (const key of Object.keys(current).sort()) {
    if (keep !== undefined && !keep.has(key)) continue;
    const from = current[key];
    if (from === undefined || unset(from)) continue;
    if (desired[key] !== undefined) continue;

    const cleared = typeof from === "boolean" ? "false" : '""';
    warnings.push(
      `${label}: ${key} を spec から外しましたが、kintone 側の ${JSON.stringify(from)} は` +
        `据え置かれます (外すには "${key}": ${cleared} と書きます)。`,
    );
  }

  return warnings;
}

/** フィールドのうち、外し方を示せる設定。 */
const FIELD_KEYS_TO_KEEP: ReadonlySet<string> = new Set([
  "required",
  "unique",
  "noLabel",
  "defaultValue",
  "minValue",
  "maxValue",
  "minLength",
  "maxLength",
  "unit",
  "digit",
  "thumbnailSize",
  "expression",
  "hideExpression",
]);

/** アプリ全体のうち、外し方を示せる設定。 */
const APP_KEYS_TO_KEEP: ReadonlySet<string> = new Set(["description"]);

const TABLE_CHANGE_LABEL: Record<TableChange["kind"], string> = {
  added: "列を追加",
  updated: "列の設定を変更",
  removed: "列を削除",
  moved: "出入り",
};

export interface AppDiff {
  readonly added: readonly FieldAddition[];
  readonly updated: readonly FieldUpdate[];
  readonly retyped: readonly FieldRetype[];
  readonly orphaned: readonly FieldOrphan[];
  /** テーブルに関わる変化。update では適用できない。 */
  readonly tableChanges: readonly TableChange[];
  /**
   * 差分にはならないが、伝えないと誤解される事柄。
   * いまのところ「spec から外したのに kintone 側に残る設定」。
   */
  readonly warnings: readonly string[];
  /** アプリ名・説明・テーマ・一般設定の変化。 */
  readonly app: readonly Change[];
  readonly views: ViewDiff;
  readonly layout: LayoutDiff;
}

/** 変更が 1 つも無いか。 */
export function isEmptyDiff(diff: AppDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.updated.length === 0 &&
    diff.retyped.length === 0 &&
    diff.orphaned.length === 0 &&
    diff.tableChanges.length === 0 &&
    diff.app.length === 0 &&
    diff.views.added.length === 0 &&
    diff.views.updated.length === 0 &&
    diff.views.removed.length === 0 &&
    // 適用されない並びの違いは、差分として数えない (何も起きないため)。
    !diff.layout.willApply
  );
}

/** 目標に近づけるために kintone を変更する必要があるか (削除候補への退避も変更に含む)。 */
export function hasWork(diff: AppDiff): boolean {
  return !isEmptyDiff(diff);
}

export function diffAppSpec(current: AppSpec, desired: AppSpec): AppDiff {
  const currentFields = byCode(current.fields);
  const desiredFields = byCode(desired.fields);

  const added: FieldAddition[] = [];
  const updated: FieldUpdate[] = [];
  const retyped: FieldRetype[] = [];
  const orphaned: FieldOrphan[] = [];
  const warnings: string[] = [];

  for (const [code, field] of desiredFields) {
    const existing = currentFields.get(code);
    if (existing === undefined) {
      added.push({ code, field });
      continue;
    }
    if (existing.type !== field.type) {
      // kintone は作成後の型を変えられない。呼び出し側で扱いを決めてもらう。
      retyped.push({ code, from: existing.type, to: field.type });
      continue;
    }
    const changes = compareFields(existing, field);
    if (changes.length > 0) {
      updated.push({ code, field, changes });
    }
    warnings.push(...staleSettings(code, existing, field, FIELD_KEYS_TO_KEEP));
  }

  warnings.push(
    ...staleSettings("(アプリ)", current, desired, APP_KEYS_TO_KEEP),
    ...staleSettings(
      "(アプリ設定)",
      (current.settings ?? {}) as Record<string, unknown>,
      (desired.settings ?? {}) as Record<string, unknown>,
    ),
  );

  for (const [code, field] of currentFields) {
    if (!desiredFields.has(code)) {
      orphaned.push({ code, type: field.type, label: field.label });
    }
  }

  return {
    added,
    updated,
    retyped,
    orphaned,
    tableChanges: compareTables(current, desired, { added, updated, orphaned }),
    warnings,
    app: compareAppSettings(current, desired),
    views: compareViews(current.views ?? [], desired.views ?? []),
    layout: compareLayout(current, desired),
  };
}

/**
 * テーブルに関わる変更を拾う。
 *
 * 列の増減・設定変更はもちろん、フィールドがテーブルを出入りしたことも見る。
 * 出入りは kintone では作り直しになり、**データが引き継がれない**ため。
 */
function compareTables(
  current: AppSpec,
  desired: AppSpec,
  changes: {
    added: readonly FieldAddition[];
    updated: readonly FieldUpdate[];
    orphaned: readonly FieldOrphan[];
  },
): TableChange[] {
  const currentTables = fieldTables(current);
  const desiredTables = fieldTables(desired);
  const result: TableChange[] = [];

  for (const entry of changes.added) {
    const table = desiredTables[entry.code];
    if (table !== undefined) result.push({ code: entry.code, table, kind: "added" });
  }
  for (const entry of changes.updated) {
    const table = desiredTables[entry.code] ?? currentTables[entry.code];
    if (table !== undefined) result.push({ code: entry.code, table, kind: "updated" });
  }
  for (const entry of changes.orphaned) {
    const table = currentTables[entry.code];
    if (table !== undefined) result.push({ code: entry.code, table, kind: "removed" });
  }

  // 両方に在るフィールドが、テーブルを出入りしていないか。
  // 名前ではなくコードで比べる (名前だけ変えても同じテーブル)。
  const codeOf = (name: string | undefined): string | undefined =>
    name === undefined ? undefined : tableCodeOf(name);
  const seen = new Set(result.map((change) => change.code));
  for (const field of desired.fields) {
    const code = resolveFieldCode(field);
    if (seen.has(code)) continue;
    const from = codeOf(currentTables[code]);
    const to = codeOf(desiredTables[code]);
    if (from === to) continue;
    const table = desiredTables[code] ?? currentTables[code]!;
    result.push({ code, table, kind: "moved" });
  }

  return result;
}

function compareLayout(current: AppSpec, desired: AppSpec): LayoutDiff {
  const currentLayout = resolveLayout(current);
  const desiredLayout = resolveLayout(desired);

  const describe = (layout: { mode: string; maxPerRow: number }): string =>
    layout.mode === "stacked" ? "stacked" : `${layout.mode} (最大 ${layout.maxPerRow} 列)`;

  const currentCodes = current.fields.map(resolveFieldCode);
  const desiredCodes = desired.fields.map(resolveFieldCode);
  const shared = new Set(currentCodes.filter((code) => desiredCodes.includes(code)));

  const orderChanged =
    JSON.stringify(currentCodes.filter((code) => shared.has(code))) !==
    JSON.stringify(desiredCodes.filter((code) => shared.has(code)));

  const currentGroups = fieldGroups(current);
  const desiredGroups = fieldGroups(desired);
  const groupsChanged = [...shared].some((code) => currentGroups[code] !== desiredGroups[code]);

  const modeChanged =
    currentLayout.mode !== desiredLayout.mode || currentLayout.maxPerRow !== desiredLayout.maxPerRow;

  // grouped は modeChanged が常に立つ (pull が stacked を返すため) ので、
  // 顔ぶれの変化は結果的にいつも拾えている。sections は同じ指定どうしを比べるので、
  // ここで明示しないと「足したフィールドがセクションの外に出る」ことになる。
  const membersChanged =
    desiredLayout.mode === "sections" &&
    (currentCodes.length !== desiredCodes.length || shared.size !== desiredCodes.length);

  return {
    from: describe(currentLayout),
    to: describe(desiredLayout),
    modeChanged,
    orderChanged,
    groupsChanged,
    membersChanged,
    // stacked は「既存の並びに手を触れない」指定なので、違いがあっても組み直さない。
    willApply:
      appliesLayout(desiredLayout.mode) &&
      (modeChanged || orderChanged || groupsChanged || membersChanged),
  };
}

function byCode(fields: readonly FieldSpec[]): Map<string, FieldSpec> {
  return new Map(fields.map((field) => [resolveFieldCode(field), field]));
}

/**
 * フィールドの設定を比べる。
 * `code` と `group` は比較から外す — 前者は同一性の鍵、
 * 後者はレイアウトの都合で kintone には送らない情報なので。
 *
 * **AppSpec で書かれていない項目は「現状維持」として扱う。**
 * kintone の設定変更 API は省略した項目を変えないので、
 * 「現状にはあるが目標には書かれていない」を変更として報告すると、
 * 実際には何も起きないのに差分が永遠に消えないことになる。
 * 値を変えたいときは、明示的に書く (例: `"required": false`)。
 */
/**
 * フィールド設定としては比べないキー。
 * `code` と `type` は同一性そのもの、`group` と `table` は kintone に送らない
 * fieldsmith 側の情報で、レイアウト差分とテーブル差分がそれぞれ見ている。
 */
const FIELD_KEYS_TO_IGNORE = new Set(["code", "type", "group", "table"]);

function compareFields(current: FieldSpec, desired: FieldSpec): Change[] {
  const keys = new Set([
    ...Object.keys(current).filter((key) => !FIELD_KEYS_TO_IGNORE.has(key)),
    ...Object.keys(desired).filter((key) => !FIELD_KEYS_TO_IGNORE.has(key)),
  ]);

  const changes: Change[] = [];
  for (const key of [...keys].sort()) {
    const from = (current as Record<string, unknown>)[key];
    const to = (desired as Record<string, unknown>)[key];
    if (to === undefined) continue;
    if (!same(from, to)) {
      changes.push({ key, from, to });
    }
  }
  return changes;
}

function compareAppSettings(current: AppSpec, desired: AppSpec): Change[] {
  const changes: Change[] = [];

  // 未指定は「現状維持」。書かれていない項目は送らないので、差分にもしない。
  for (const key of ["name", "description", "theme", "icon", "iconBackground"] as const) {
    if (desired[key] === undefined) continue;
    if (!same(current[key], desired[key])) {
      changes.push({ key, from: current[key], to: desired[key] });
    }
  }

  const currentSettings = (current.settings ?? {}) as Record<string, unknown>;
  const desiredSettings = (desired.settings ?? {}) as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(currentSettings), ...Object.keys(desiredSettings)])].sort()) {
    if (desiredSettings[key] === undefined) continue;
    if (!same(currentSettings[key], desiredSettings[key])) {
      changes.push({ key: `settings.${key}`, from: currentSettings[key], to: desiredSettings[key] });
    }
  }

  return changes;
}

/** 一覧は名前で対応付ける。 */
function compareViews(current: readonly ViewSpec[], desired: readonly ViewSpec[]): ViewDiff {
  const currentByName = new Map(current.map((view) => [view.name, view]));
  const desiredByName = new Map(desired.map((view) => [view.name, view]));

  const added: ViewSpec[] = [];
  const updated: { name: string; view: ViewSpec; changes: Change[] }[] = [];

  for (const [name, view] of desiredByName) {
    const existing = currentByName.get(name);
    if (existing === undefined) {
      added.push(view);
      continue;
    }
    const changes: Change[] = [];
    const keys = new Set([...Object.keys(existing), ...Object.keys(view)]);
    for (const key of [...keys].sort()) {
      if (key === "name") continue;
      const from = (existing as Record<string, unknown>)[key];
      const to = (view as Record<string, unknown>)[key];
      if (!same(from, to)) changes.push({ key, from, to });
    }
    if (changes.length > 0) updated.push({ name, view, changes });
  }

  const removed = [...currentByName.keys()].filter((name) => !desiredByName.has(name));
  return { added, updated, removed };
}

/**
 * 値を比べる。
 *
 * 真偽値の設定は kintone の既定が false なので、**未指定と false は同じ**とみなす。
 * ここを分けると「required を書いていないフィールド」と
 * 「required: false と書いたフィールド」が毎回差分になり、無意味な変更が出続ける。
 */
/**
 * 2 つの設定値が同じ意味か。
 *
 * 「未指定」は `false` とも空文字とも同じ意味になる。
 * kintone は未設定の上限などを空文字で返し、`pull` はそれを落とすので、
 * 区別すると「制限を外した spec」が毎回差分に出続ける。
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined) return unset(b);
  if (b === undefined) return unset(a);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 未指定と同じ意味を持つ値。 */
function unset(value: unknown): boolean {
  return value === false || value === "";
}

/** 差分を人が読める行にする。 */
export function describeDiff(diff: AppDiff): string[] {
  const lines: string[] = [];
  const show = (value: unknown): string =>
    value === undefined ? "(なし)" : typeof value === "string" ? value : JSON.stringify(value);

  for (const change of diff.app) {
    lines.push(`  ~ ${change.key}: ${show(change.from)} → ${show(change.to)}`);
  }
  for (const addition of diff.added) {
    lines.push(`  + ${addition.code} (${addition.field.type}) を追加`);
  }
  for (const update of diff.updated) {
    const detail = update.changes
      .map((change) => `${change.key}: ${show(change.from)} → ${show(change.to)}`)
      .join(", ");
    lines.push(`  ~ ${update.code}: ${detail}`);
  }
  for (const retype of diff.retyped) {
    lines.push(`  ! ${retype.code}: 型を ${retype.from} → ${retype.to} に変更 (kintone では不可)`);
  }
  for (const change of diff.tableChanges) {
    lines.push(
      `  ! ${change.code}: テーブル「${change.table}」の${TABLE_CHANGE_LABEL[change.kind]}` +
        " (update では反映できない)",
    );
  }
  for (const orphan of diff.orphaned) {
    lines.push(`  - ${orphan.code} (${orphan.type}) を削除候補へ`);
  }
  if (diff.layout.willApply) {
    const reasons = [
      diff.layout.modeChanged ? `指定: ${diff.layout.from} → ${diff.layout.to}` : null,
      diff.layout.orderChanged ? "並び順" : null,
      diff.layout.groupsChanged ? "group" : null,
      diff.layout.membersChanged ? "フィールドの増減" : null,
    ].filter((reason): reason is string => reason !== null);
    lines.push(`  ~ フォームの並びを組み直す (${reasons.join(", ")})`);
  }
  for (const view of diff.views.added) {
    lines.push(`  + 一覧「${view.name}」を追加`);
  }
  for (const view of diff.views.updated) {
    lines.push(`  ~ 一覧「${view.name}」: ${view.changes.map((c) => c.key).join(", ")}`);
  }
  for (const name of diff.views.removed) {
    lines.push(`  - 一覧「${name}」を削除`);
  }

  return lines;
}
