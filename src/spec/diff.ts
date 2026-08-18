import { fieldGroups, resolveFieldCode, resolveLayout, type AppSpec, type ViewSpec } from "./appSpec.js";
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
   * 実際にレイアウトを組み直すか。
   * 目標が `stacked` の場合は既存の並びに手を触れないので、変化があっても適用しない。
   */
  readonly willApply: boolean;
}

export interface AppDiff {
  readonly added: readonly FieldAddition[];
  readonly updated: readonly FieldUpdate[];
  readonly retyped: readonly FieldRetype[];
  readonly orphaned: readonly FieldOrphan[];
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
  }

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
    app: compareAppSettings(current, desired),
    views: compareViews(current.views ?? [], desired.views ?? []),
    layout: compareLayout(current, desired),
  };
}

function compareLayout(current: AppSpec, desired: AppSpec): LayoutDiff {
  const currentLayout = resolveLayout(current);
  const desiredLayout = resolveLayout(desired);

  const describe = (layout: { mode: string; maxPerRow: number }): string =>
    layout.mode === "grouped" ? `grouped (最大 ${layout.maxPerRow} 列)` : "stacked";

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

  return {
    from: describe(currentLayout),
    to: describe(desiredLayout),
    modeChanged,
    orderChanged,
    groupsChanged,
    // stacked は「既存の並びに手を触れない」指定なので、違いがあっても組み直さない。
    willApply: desiredLayout.mode === "grouped" && (modeChanged || orderChanged || groupsChanged),
  };
}

function byCode(fields: readonly FieldSpec[]): Map<string, FieldSpec> {
  return new Map(fields.map((field) => [resolveFieldCode(field), field]));
}

/**
 * フィールドの設定を比べる。
 * `code` と `group` は比較から外す — 前者は同一性の鍵、
 * 後者はレイアウトの都合で kintone には送らない情報なので。
 */
const FIELD_KEYS_TO_IGNORE = new Set(["code", "type", "group"]);

function compareFields(current: FieldSpec, desired: FieldSpec): Change[] {
  const keys = new Set([
    ...Object.keys(current).filter((key) => !FIELD_KEYS_TO_IGNORE.has(key)),
    ...Object.keys(desired).filter((key) => !FIELD_KEYS_TO_IGNORE.has(key)),
  ]);

  const changes: Change[] = [];
  for (const key of [...keys].sort()) {
    const from = (current as Record<string, unknown>)[key];
    const to = (desired as Record<string, unknown>)[key];
    if (!same(from, to)) {
      changes.push({ key, from, to });
    }
  }
  return changes;
}

function compareAppSettings(current: AppSpec, desired: AppSpec): Change[] {
  const changes: Change[] = [];

  for (const key of ["name", "description", "theme", "icon", "iconBackground"] as const) {
    if (!same(current[key], desired[key])) {
      changes.push({ key, from: current[key], to: desired[key] });
    }
  }

  const currentSettings = (current.settings ?? {}) as Record<string, unknown>;
  const desiredSettings = (desired.settings ?? {}) as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(currentSettings), ...Object.keys(desiredSettings)])].sort()) {
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

/** 未指定と既定値を同じものとして扱わないよう、素直に深く比べる。 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
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
  for (const orphan of diff.orphaned) {
    lines.push(`  - ${orphan.code} (${orphan.type}) を削除候補へ`);
  }
  if (diff.layout.willApply) {
    const reasons = [
      diff.layout.modeChanged ? `指定: ${diff.layout.from} → ${diff.layout.to}` : null,
      diff.layout.orderChanged ? "並び順" : null,
      diff.layout.groupsChanged ? "group" : null,
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
