import type { KintoneProperties } from "../spec/fromKintone.js";
import { collectLayoutFields, type LayoutField, type LayoutRow } from "../spec/layout.js";
import {
  describeAppRef,
  type AppRef,
  type Link,
  type LinkFile,
  type LookupLink,
  type ReferenceTableLink,
} from "../spec/linkSpec.js";
import type { AuthenticatedKintone } from "./client.js";
import { waitForDeployment, type PollingOptions } from "./deploy.js";

/**
 * アプリ間の結線を反映する。
 *
 * **AppSpec は受け取らない。** 結線が正しいかは spec ではなく**実物**と突き合わせる。
 * spec は実物とずれうるし、相手アプリのフィールドは spec の外にあるため。
 *
 * ルックアップと関連レコード一覧で、フィールドの持ち主が違う。
 *   - `LOOKUP`          … 値が入る。**AppSpec が作ったフィールド**に設定を足すだけ
 *   - `REFERENCE_TABLE` … 値を持たない。**link がフィールドを作る**
 */

export interface LinkProgress {
  readonly step: "resolve" | "inspect" | "apply" | "layout" | "deploy" | "polling";
  readonly message: string;
  readonly detail?: string;
}

export class LinkValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = "LinkValidationError";
  }
}

/** 1 つの結線について、何をするか。 */
export interface LinkPlanEntry {
  readonly link: Link;
  readonly appId: string;
  readonly relatedAppId: string;
  readonly action: "add" | "update" | "unchanged";
  /** 変わる項目。`unchanged` なら空。 */
  readonly changes: readonly string[];
  /** 位置を直す必要があるか。 */
  readonly moves: boolean;
  /**
   * ルックアップを載せるフィールドの、いまの型。
   * 設定を送るときに型も一緒に送る必要があるので、実物から拾っておく。
   */
  readonly hostType?: string;
}

export interface LinkPlan {
  readonly entries: readonly LinkPlanEntry[];
  /** 反映はしないが伝えること。ファイルに無い結線が kintone 側にある場合など。 */
  readonly warnings: readonly string[];
}

/* ------------------------------ 読み取りと計画 ------------------------------ */

interface AppForm {
  readonly appId: string;
  readonly name: string;
  readonly properties: KintoneProperties;
  readonly layout: LayoutRow[];
}

/**
 * 何が起きるかを求める。**kintone を変更しない。**
 *
 * 相手アプリのフィールドが実在するかは繋がないと確かめようがないので、
 * `--dry-run` でも読み取りだけは接続する。`deploy --dry-run` (無接続) とは性格が違う。
 */
export async function planLinks(
  file: LinkFile,
  kintone: AuthenticatedKintone,
  options: { readonly onProgress?: (progress: LinkProgress) => void } = {},
): Promise<LinkPlan> {
  const report = options.onProgress ?? (() => {});

  report({ step: "resolve", message: "アプリを解決しています" });
  const resolved = await resolveApps(file, kintone);

  report({ step: "inspect", message: "フォームの現状を読んでいます" });
  const forms = new Map<string, AppForm>();
  for (const appId of new Set([...resolved.values()])) {
    forms.set(appId, await readForm(appId, kintone));
  }

  const issues: { path: string; message: string }[] = [];
  const entries: LinkPlanEntry[] = [];

  file.links.forEach((link, index) => {
    const at = (key: string): string => `links.${index}.${key}`;
    const appId = resolved.get(refKey(link.app))!;
    const relatedAppId = resolved.get(refKey(link.relatedApp))!;
    const form = forms.get(appId)!;
    const related = forms.get(relatedAppId)!;

    const found = validate(link, at, form, related, issues);
    if (!found) return;

    const desired = link.type === "REFERENCE_TABLE"
      ? toReferenceTable(link, relatedAppId)
      : toLookup(link, relatedAppId);
    const property = form.properties[link.code];
    const settingKey = link.type === "REFERENCE_TABLE" ? "referenceTable" : "lookup";
    const current = property?.[settingKey] as Record<string, unknown> | undefined;

    const changes = current === undefined ? [] : differences(current, desired);
    const action: LinkPlanEntry["action"] =
      property === undefined ? "add" : current === undefined || changes.length > 0 ? "update" : "unchanged";

    entries.push({
      link,
      appId,
      relatedAppId,
      action,
      changes,
      moves: link.type === "REFERENCE_TABLE" && needsMove(form.layout, link.code, link.placeAfter),
      ...(property === undefined ? {} : { hostType: String(property["type"]) }),
    });
  });

  if (issues.length > 0) {
    throw new LinkValidationError("結線を反映できません", issues);
  }

  return { entries, warnings: unmanagedLinks(file, forms, resolved) };
}

/** アプリコードをアプリ ID に解決する。`relatedApp.code` の解釈に頼らず、こちらで引く。 */
async function resolveApps(
  file: LinkFile,
  kintone: AuthenticatedKintone,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const codes = new Set<string>();

  for (const link of file.links) {
    for (const ref of [link.app, link.relatedApp]) {
      if (typeof ref === "number") resolved.set(refKey(ref), String(ref));
      else codes.add(ref);
    }
  }
  if (codes.size === 0) return resolved;

  // アプリコードとして通らない文字列だと kintone 側で弾かれる。
  // 生のエラーを出すと、どの行が悪いのか分からない。
  let found: { apps: { appId: string; code: string }[] };
  try {
    found = await kintone.call((client) => client.app.getApps({ codes: [...codes] }));
  } catch (error) {
    throw new LinkValidationError("結線を反映できません", [
      {
        path: "app",
        message:
          `アプリコードを引けませんでした (${[...codes].map((c) => `"${c}"`).join(", ")}): ` +
          `${(error as Error).message}`,
      },
    ]);
  }
  for (const app of found.apps) resolved.set(refKey(app.code), app.appId);

  const missing = [...codes].filter((code) => !resolved.has(refKey(code)));
  if (missing.length > 0) {
    throw new LinkValidationError(
      "結線を反映できません",
      missing.map((code) => ({
        path: "app",
        message:
          `アプリコード "${code}" のアプリが見つかりません。` +
          " kintone 側でアプリコードが設定されているか確認してください。",
      })),
    );
  }
  return resolved;
}

async function readForm(appId: string, kintone: AuthenticatedKintone): Promise<AppForm> {
  const [settings, form, layout] = await Promise.all([
    kintone.call((client) => client.app.getAppSettings({ app: appId, preview: true })),
    kintone.call((client) => client.app.getFormFields({ app: appId, preview: true })),
    kintone.call((client) => client.app.getFormLayout({ app: appId, preview: true })),
  ]);
  return {
    appId,
    name: settings.name,
    properties: form.properties as unknown as KintoneProperties,
    layout: layout.layout as unknown as LayoutRow[],
  };
}

/* ------------------------------ 検証 ------------------------------ */

/** ルックアップにできるフィールド型。実体はこれらに設定が付いたもの。 */
const LOOKUP_HOST_TYPES = new Set(["SINGLE_LINE_TEXT", "NUMBER", "LINK"]);

function validate(
  link: Link,
  at: (key: string) => string,
  form: AppForm,
  related: AppForm,
  issues: { path: string; message: string }[],
): boolean {
  const before = issues.length;
  const here = (code: string, key: string): void => {
    if (form.properties[code] === undefined) {
      issues.push({ path: at(key), message: `"${code}" は ${form.name} にありません` });
    }
  };
  const there = (code: string, key: string): void => {
    if (related.properties[code] === undefined) {
      issues.push({ path: at(key), message: `"${code}" は参照先の ${related.name} にありません` });
    }
  };

  if (link.type === "REFERENCE_TABLE") {
    here(link.condition.field, "condition.field");
    there(link.condition.relatedField, "condition.relatedField");
    link.displayFields.forEach((code, i) => there(code, `displayFields.${i}`));
    if (link.placeAfter !== undefined) here(link.placeAfter, "placeAfter");

    // 既に在るなら、それが関連レコード一覧であること。別の型を踏み潰さない。
    const property = form.properties[link.code];
    if (property !== undefined && String(property["type"]) !== "REFERENCE_TABLE") {
      issues.push({
        path: at("code"),
        message:
          `"${link.code}" は既に ${String(property["type"])} として存在します。` +
          " 別のフィールドコードにしてください。",
      });
    }
    return issues.length === before;
  }

  // ルックアップは既にあるフィールドに設定を足すだけ。無ければ AppSpec 側の問題。
  const property = form.properties[link.code];
  if (property === undefined) {
    issues.push({
      path: at("code"),
      message:
        `"${link.code}" は ${form.name} にありません。` +
        " ルックアップにするフィールドは AppSpec で作ってください (link は作りません)。",
    });
  } else if (!LOOKUP_HOST_TYPES.has(String(property["type"]))) {
    issues.push({
      path: at("code"),
      message:
        `"${link.code}" は ${String(property["type"])} なのでルックアップにできません` +
        ` (${[...LOOKUP_HOST_TYPES].join(" / ")} のいずれか)。`,
    });
  }

  const key = related.properties[link.relatedKeyField];
  if (key === undefined) {
    issues.push({
      path: at("relatedKeyField"),
      message: `"${link.relatedKeyField}" は参照先の ${related.name} にありません`,
    });
  } else if (key["unique"] !== true) {
    // kintone の決まり。ここで弾かないとデプロイの途中で落ちる。
    issues.push({
      path: at("relatedKeyField"),
      message:
        `"${link.relatedKeyField}" に重複禁止が設定されていません。` +
        " ルックアップのキーには重複禁止が要ります。",
    });
  }

  link.fieldMappings?.forEach((mapping, i) => {
    here(mapping.field, `fieldMappings.${i}.field`);
    there(mapping.relatedField, `fieldMappings.${i}.relatedField`);
  });
  link.lookupPickerFields?.forEach((code, i) => there(code, `lookupPickerFields.${i}`));

  return issues.length === before;
}

/* ------------------------------ kintone に送る形 ------------------------------ */

export function toReferenceTable(
  link: ReferenceTableLink,
  relatedAppId: string,
): Record<string, unknown> {
  const setting: Record<string, unknown> = {
    relatedApp: { app: relatedAppId },
    condition: { field: link.condition.field, relatedField: link.condition.relatedField },
    displayFields: [...link.displayFields],
  };
  assign(setting, "filterCond", link.filterCond);
  assign(setting, "sort", link.sort);
  assign(setting, "size", link.size === undefined ? undefined : String(link.size));
  return setting;
}

export function toLookup(link: LookupLink, relatedAppId: string): Record<string, unknown> {
  const setting: Record<string, unknown> = {
    relatedApp: { app: relatedAppId },
    relatedKeyField: link.relatedKeyField,
  };
  assign(setting, "fieldMappings", link.fieldMappings);
  assign(setting, "lookupPickerFields", link.lookupPickerFields);
  assign(setting, "filterCond", link.filterCond);
  assign(setting, "sort", link.sort);
  return setting;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/**
 * 書いた項目だけを比べる。
 *
 * **kintone は書かなかった項目を勝手に埋める** (`sort` に `レコード番号 desc`、`size` に `5`)。
 * 全部を比べると、中身は同じなのに毎回「変わった」と言い続けることになる。
 * AppSpec の「書かれていない項目は現状維持」と同じ扱いにする。
 */
export function differences(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const [key, want] of Object.entries(desired)) {
    const have = key === "relatedApp"
      ? { app: (current["relatedApp"] as { app?: string } | undefined)?.app }
      : current[key];
    if (JSON.stringify(have) !== JSON.stringify(want)) changed.push(key);
  }
  return changed;
}

/* ------------------------------ 位置 ------------------------------ */

/** そのフィールドが、指定の位置に居ないか。 */
export function needsMove(
  layout: readonly LayoutRow[],
  code: string,
  after: string | undefined,
): boolean {
  if (after === undefined) return false;
  const anchor = rowIndexOf(layout, after);
  const target = rowIndexOf(layout, code);
  if (anchor === -1) return false;
  // まだ無い場合も、追加したあとに動かす必要がある。
  return target === -1 || target !== anchor + 1;
}

/**
 * フィールドを、指定したフィールドの直後の行へ移す。
 *
 * 元の行に他のフィールドが居る場合は、そこから抜き出して単独の行にする。
 * レイアウト変更 API はフォーム上のすべてのフィールドを求めるので、取りこぼさない。
 */
export function moveAfter(
  layout: readonly LayoutRow[],
  code: string,
  after: string,
  type = "REFERENCE_TABLE",
): LayoutRow[] {
  const moved: LayoutField = { code, type };

  // いったん取り除く。空になった行は落とす。
  const without: LayoutRow[] = [];
  for (const row of layout) {
    if (row.type !== "ROW") {
      without.push(row);
      continue;
    }
    const fields = ((row as { fields?: LayoutField[] }).fields ?? []).filter(
      (field) => field.code !== code,
    );
    if (fields.length > 0) without.push({ type: "ROW", fields });
  }

  const anchor = rowIndexOf(without, after);
  const row: LayoutRow = { type: "ROW", fields: [moved] };
  if (anchor === -1) return [...without, row];
  return [...without.slice(0, anchor + 1), row, ...without.slice(anchor + 1)];
}

function rowIndexOf(layout: readonly LayoutRow[], code: string): number {
  return layout.findIndex((row) => collectLayoutFields([row]).some((field) => field.code === code));
}

/* ------------------------------ 消さない ------------------------------ */

/**
 * ファイルに無い結線が kintone 側にある場合に知らせる。
 * **消さない。** フィールドを削除しない方針と揃える。
 */
function unmanagedLinks(
  file: LinkFile,
  forms: ReadonlyMap<string, AppForm>,
  resolved: ReadonlyMap<string, string>,
): string[] {
  const managed = new Set(
    file.links.map((link) => `${resolved.get(refKey(link.app))!} ${link.code}`),
  );
  const warnings: string[] = [];

  for (const [appId, form] of forms) {
    for (const [code, property] of Object.entries(form.properties)) {
      const isLink =
        String(property["type"]) === "REFERENCE_TABLE" || property["lookup"] !== undefined;
      if (!isLink || managed.has(`${appId} ${code}`)) continue;
      warnings.push(
        `${form.name} の "${code}" は結線ファイルにありませんが、kintone 側には設定があります` +
          " (link では消しません)。",
      );
    }
  }
  return warnings;
}

function refKey(ref: AppRef): string {
  return typeof ref === "number" ? `#${ref}` : `@${ref}`;
}

/** 計画を人が読める形にする。 */
export function describePlan(plan: LinkPlan): string[] {
  const lines: string[] = [];
  for (const entry of plan.entries) {
    // アプリ ID で書かれているときに「アプリ 776 (776)」と二度言わない。
    const where =
      typeof entry.link.relatedApp === "number"
        ? `アプリ ${entry.relatedAppId}`
        : `${describeAppRef(entry.link.relatedApp)} → アプリ ${entry.relatedAppId}`;
    const what = `${entry.link.code} → ${where}`;
    if (entry.action === "add") lines.push(`  + ${what} を作る`);
    else if (entry.action === "update") lines.push(`  ~ ${what}: ${entry.changes.join(", ")}`);
    else if (entry.moves) lines.push(`  ~ ${what}: 位置`);
    else lines.push(`  = ${what} (変更なし)`);
  }
  return lines;
}

/* ------------------------------ 反映 ------------------------------ */

export interface LinkOptions {
  /** 運用環境まで反映するか。既定は動作テスト環境で止める。 */
  readonly deploy?: boolean;
  readonly onProgress?: (progress: LinkProgress) => void;
  readonly polling?: PollingOptions;
}

export interface LinkedApp {
  readonly appId: string;
  readonly name: string;
  readonly revision: string;
}

export interface LinkResult {
  readonly plan: LinkPlan;
  readonly deployed: boolean;
  readonly apps: readonly LinkedApp[];
}

/**
 * 結線を反映する。
 *
 * **既定では動作テスト環境で止める。** フォームを変える操作なので、
 * kintone の画面で確認してから人が反映を決められるようにする (`update` と同じ)。
 *
 * アプリごとに順に処理する。途中で失敗した場合、それより前のアプリは既に
 * 変わっているので、どこまで進んだかを必ず返す。
 */
export async function applyLinks(
  file: LinkFile,
  kintone: AuthenticatedKintone,
  options: LinkOptions = {},
): Promise<LinkResult> {
  const report = options.onProgress ?? (() => {});
  const plan = await planLinks(file, kintone, { onProgress: report });

  const byApp = new Map<string, LinkPlanEntry[]>();
  for (const entry of plan.entries) {
    const list = byApp.get(entry.appId);
    if (list === undefined) byApp.set(entry.appId, [entry]);
    else list.push(entry);
  }

  const apps: LinkedApp[] = [];

  for (const [appId, entries] of byApp) {
    const todo = entries.filter((entry) => entry.action !== "unchanged" || entry.moves);
    if (todo.length === 0) continue;

    const settings = await kintone.call((client) =>
      client.app.getAppSettings({ app: appId, preview: true }),
    );
    let revision = "-1";

    const additions: Record<string, unknown> = {};
    const updates: Record<string, unknown> = {};
    for (const entry of entries) {
      if (entry.action === "unchanged") continue;
      const setting = entry.link.type === "REFERENCE_TABLE"
        ? { referenceTable: toReferenceTable(entry.link, entry.relatedAppId) }
        : { lookup: toLookup(entry.link, entry.relatedAppId) };
      const property = {
        // 型は変えない。既にあるフィールドはその型のまま、新しく作るのは関連レコード一覧。
        type: entry.link.type === "REFERENCE_TABLE" ? "REFERENCE_TABLE" : hostTypeOf(entry),
        code: entry.link.code,
        ...(entry.link.type === "REFERENCE_TABLE" ? { label: entry.link.label } : {}),
        ...setting,
      };
      if (entry.action === "add") additions[entry.link.code] = property;
      else updates[entry.link.code] = property;
    }

    if (Object.keys(additions).length > 0) {
      report({
        step: "apply",
        message: `${settings.name}: ${Object.keys(additions).length} 件の関連レコード一覧を作ります`,
        detail: Object.keys(additions).join(", "),
      });
      const result = await kintone.call((client) =>
        client.app.addFormFields({ app: appId, properties: additions as never }),
      );
      revision = result.revision;
    }

    if (Object.keys(updates).length > 0) {
      report({
        step: "apply",
        message: `${settings.name}: ${Object.keys(updates).length} 件の結線を変更します`,
        detail: Object.keys(updates).join(", "),
      });
      const result = await kintone.call((client) =>
        client.app.updateFormFields({ app: appId, revision, properties: updates as never }),
      );
      revision = result.revision;
    }

    // 追加したフィールドは kintone がフォーム末尾に置く。位置の指定があれば直す。
    const moving = entries.filter(
      (entry): entry is LinkPlanEntry & { link: ReferenceTableLink } =>
        entry.link.type === "REFERENCE_TABLE" && entry.link.placeAfter !== undefined,
    );
    if (moving.length > 0) {
      const now = await kintone.call((client) =>
        client.app.getFormLayout({ app: appId, preview: true }),
      );
      let layout = now.layout as unknown as LayoutRow[];
      for (const entry of moving) layout = moveAfter(layout, entry.link.code, entry.link.placeAfter!);

      report({
        step: "layout",
        message: `${settings.name}: 置き場所を整えます`,
        detail: moving.map((entry) => `${entry.link.code} → ${entry.link.placeAfter!} の直後`).join(", "),
      });
      const result = await kintone.call((client) =>
        client.app.updateFormLayout({ app: appId, revision, layout } as never),
      );
      revision = result.revision;
    }

    if (options.deploy === true) {
      report({ step: "deploy", message: `${settings.name}: 運用環境へ反映します` });
      await kintone.call((client) => client.app.deployApp({ apps: [{ app: appId, revision }] }));
      await waitForDeployment(appId, kintone, options.polling, (progress) =>
        report({ step: "polling", message: progress.message, ...(progress.detail === undefined ? {} : { detail: progress.detail }) }),
      );
    }

    apps.push({ appId, name: settings.name, revision });
  }

  return { plan, deployed: options.deploy === true, apps };
}

/**
 * ルックアップを載せるフィールドの型。
 * 型は変えない。実物から拾った型をそのまま送り返す。
 */
function hostTypeOf(entry: LinkPlanEntry): string {
  return entry.hostType ?? "SINGLE_LINE_TEXT";
}
