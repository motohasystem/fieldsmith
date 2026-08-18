import type { KintoneRestAPIClient } from "@kintone/rest-api-client";
import { toAppSpecFromKintone, type KintoneProperties } from "../spec/fromKintone.js";
import {
  buildUpdatedLayout,
  collectLayoutFields,
  describeRows,
  ORPHAN_GROUP_CODE,
  ORPHAN_GROUP_LABEL,
  regroupLayout,
  type LayoutRow,
} from "../spec/layout.js";
import { diffAppSpec, isEmptyDiff, type AppDiff } from "../spec/diff.js";
import {
  fieldGroups,
  parseAppSpec,
  resolveFieldCode,
  resolveLayout,
  type AppSpec,
} from "../spec/appSpec.js";
import {
  toAppSettings,
  toFieldProperties,
  toKintonePayloads,
  toViews,
  type KintoneFieldProperties,
} from "../spec/toKintone.js";
import { backgroundFor, renderIcon } from "../icon/render.js";
import { apiPathPrefix, KintoneRequestError, type AuthenticatedKintone } from "./client.js";

/** フィールド追加 API 1 回あたりに送るフィールド数の上限。kintone の上限より十分小さく取る。 */
export const FIELD_CHUNK_SIZE = 100;

export interface DeployProgress {
  readonly step:
    | "createApp"
    | "addFields"
    | "updateLayout"
    | "uploadIcon"
    | "updateSettings"
    | "updateViews"
    | "deploy"
    | "polling";
  readonly message: string;
  /** --verbose のときだけ表示する補足 (アプリ ID、revision、反映状況など)。 */
  readonly detail?: string;
}

export interface DeployOptions {
  /** アプリを作成するスペース ID。省略時は「スペースに属さないアプリ」になる。 */
  readonly spaceId?: number | string;
  /**
   * スペース内のスレッド ID。
   * kintone がスレッドの指定を求める場合に使う (スペースの URL から読み取れる)。
   */
  readonly threadId?: number | string;
  /** ゲストスペース ID。API のパスの前置きが変わる。 */
  readonly guestSpaceId?: number | string;
  /** 失敗時にテスト環境の変更を破棄するか。既定は false (調査のためアプリを残す)。 */
  readonly revertOnFailure?: boolean;
  readonly onProgress?: (progress: DeployProgress) => void;
  /** 反映状況のポーリング設定。テストから短縮するために露出している。 */
  readonly polling?: PollingOptions;
}

export interface PollingOptions {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface DeployResult {
  readonly appId: string;
  readonly revision: string;
}

/** デプロイの途中で失敗したことを、作成済みアプリの ID とともに伝える。 */
export class DeployError extends Error {
  constructor(
    message: string,
    readonly appId: string | null,
    readonly step: DeployProgress["step"],
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DeployError";
  }
}

/**
 * AppSpec を kintone にデプロイする。
 *
 * 「動作テスト環境に変更を積む → 運用環境へ反映する」という kintone の 2 段構えをそのままなぞる:
 *   1. テスト環境にアプリを作成
 *   2. フィールドを追加
 *   3. 一般設定を変更 (指定がある場合)
 *   4. 一覧を変更 (指定がある場合)
 *   5. 運用環境へ反映 (非同期)
 *   6. 反映完了までポーリング
 *
 * 各ステップが返す revision を次の呼び出しに引き回すことで、
 * 同じアプリを別の誰かが同時に編集していた場合に kintone 側で検出させる。
 */
export async function deployAppSpec(
  spec: AppSpec,
  kintone: AuthenticatedKintone,
  options: DeployOptions = {},
): Promise<DeployResult> {
  const payloads = toKintonePayloads(spec);
  const report = options.onProgress ?? (() => {});

  report({ step: "createApp", message: `アプリ「${payloads.appName}」を動作テスト環境に作成します` });

  const created = await createPreviewApp(payloads.appName, kintone, options).catch(
    (error: unknown) => {
      throw new DeployError(describe("アプリの作成に失敗しました", error), null, "createApp", error);
    },
  );

  const appId = created.app;
  let revision = created.revision;
  let step: DeployProgress["step"] = "addFields";

  report({
    step: "createApp",
    message: `アプリ ID ${appId} を作成しました`,
    detail: `revision=${revision}`,
  });

  try {
    step = "addFields";
    const chunks = chunk(payloads.properties, FIELD_CHUNK_SIZE);
    for (const [index, properties] of chunks.entries()) {
      report({
        step: "addFields",
        message:
          chunks.length === 1
            ? `フィールドを ${Object.keys(properties).length} 件追加します`
            : `フィールドを追加します (${index + 1}/${chunks.length})`,
      });
      const result = await kintone.call((client) =>
        client.app.addFormFields({ app: appId, properties, revision }),
      );
      report({
        step: "addFields",
        message: `フィールドを追加しました`,
        detail: `${Object.keys(properties).join(", ")} / revision ${revision} → ${result.revision}`,
      });
      revision = result.revision;
    }

    const layout = resolveLayout(spec);
    if (layout.mode === "grouped") {
      step = "updateLayout";
      report({ step: "updateLayout", message: "フォームの並びを整えています" });

      // 推測で組み立てず、kintone が実際に置いたレイアウトを取得して並べ替える。
      // このAPIは「フォーム上のすべてのフィールド」の指定を求めるため、
      // 実物を起点にするのが最も確実。
      const current = await kintone.call((client) =>
        client.app.getFormLayout({ app: appId, preview: true }),
      );
      const regrouped = regroupLayout(current.layout as unknown as LayoutRow[], {
        maxPerRow: layout.maxPerRow,
        // kintone のレイアウトには group が無いので、AppSpec 側の対応表を渡す。
        groups: fieldGroups(spec),
      });

      const result = await kintone.call((client) =>
        client.app.updateFormLayout({
          app: appId,
          revision,
          layout: regrouped,
        } as Parameters<KintoneRestAPIClient["app"]["updateFormLayout"]>[0]),
      );
      report({
        step: "updateLayout",
        message: `フォームを ${regrouped.length} 行に整えました`,
        detail:
          describeRows(
            regrouped
              .filter((row) => row.type === "ROW")
              .map((row) => (row as { fields: { type: string; code: string }[] }).fields),
          ).join(" / ") + ` / revision ${revision} → ${result.revision}`,
      });
      revision = result.revision;
    }

    // アイコンは fileKey が要るので、一般設定を送る前にアップロードしておく。
    let settings = payloads.settings;
    if (spec.icon !== undefined) {
      step = "uploadIcon";
      const background = spec.iconBackground ?? backgroundFor(spec.name);
      report({
        step: "uploadIcon",
        message: `アイコンを生成しています (${spec.icon})`,
        detail: `背景色 ${background}`,
      });

      const icon = renderIcon({ glyph: spec.icon, background });
      const { fileKey } = await kintone.call((client) =>
        client.file.uploadFile({ file: { name: "app-icon.png", data: icon.png } }),
      );
      report({
        step: "uploadIcon",
        message: `アイコンをアップロードしました (${icon.mode === "emoji" ? "絵文字" : "文字"})`,
        detail: `${Math.round(icon.png.length / 1024)}KB, fileKey=${fileKey}`,
      });

      settings = { ...(settings ?? {}), icon: { type: "FILE", file: { fileKey } } };
    }

    if (settings !== null) {
      step = "updateSettings";
      report({ step: "updateSettings", message: "アプリの一般設定を適用します" });
      const result = await kintone.call((client) =>
        client.app.updateAppSettings({
          app: appId,
          revision,
          ...settings,
        } as Parameters<KintoneRestAPIClient["app"]["updateAppSettings"]>[0]),
      );
      report({
        step: "updateSettings",
        message: "一般設定を適用しました",
        detail: `${Object.keys(settings).join(", ")} / revision ${revision} → ${result.revision}`,
      });
      revision = result.revision;
    }

    if (payloads.views !== null) {
      step = "updateViews";
      report({ step: "updateViews", message: "一覧を設定します" });
      const result = await kintone.call((client) =>
        client.app.updateViews({
          app: appId,
          revision,
          views: payloads.views,
        } as Parameters<KintoneRestAPIClient["app"]["updateViews"]>[0]),
      );
      report({
        step: "updateViews",
        message: "一覧を設定しました",
        detail: `${Object.keys(payloads.views).join(", ")} / revision ${revision} → ${result.revision}`,
      });
      revision = result.revision;
    }

    step = "deploy";
    report({
      step: "deploy",
      message: "運用環境へ反映します",
      detail: `POST /k/v1/preview/app/deploy.json (app=${appId}, revision=${revision})`,
    });
    await kintone.call((client) => client.app.deployApp({ apps: [{ app: appId, revision }] }));

    step = "polling";
    report({ step: "polling", message: "反映の完了を待っています" });
    await waitForDeployment(appId, kintone, options.polling, report);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    if (options.revertOnFailure === true) {
      await revertQuietly(appId, kintone);
    }
    throw new DeployError(
      `${describe("デプロイに失敗しました", error)}\n` +
        (options.revertOnFailure === true
          ? `動作テスト環境の変更を破棄しました (アプリ ID: ${appId})。`
          : `動作テスト環境にアプリ ID ${appId} が残っています。` +
            " 破棄する場合は kintone の画面から、または --revert-on-failure を付けて再実行してください。"),
      appId,
      step,
      error,
    );
  }

  return { appId, revision };
}

/**
 * 動作テスト環境にアプリを作成する。
 *
 * スペースを指定する場合は REST API を直接叩く。
 * `@kintone/rest-api-client` の addApp() は、スペース指定時に
 * デフォルトスレッドを調べるため `GET /k/v1/space.json` を呼ぶが、
 * **この API は OAuth 認証に対応していない** (パスワード認証とセッション認証のみ) ため、
 * OAuth で動く vck からは使えない。
 */
async function createPreviewApp(
  name: string,
  kintone: AuthenticatedKintone,
  options: DeployOptions,
): Promise<{ app: string; revision: string }> {
  if (options.spaceId === undefined) {
    return await kintone.call((client) => client.app.addApp({ name }));
  }

  const path = `${apiPathPrefix(options.guestSpaceId)}/preview/app.json`;
  try {
    return await kintone.request("POST", path, {
      name,
      space: options.spaceId,
      ...(options.threadId === undefined ? {} : { thread: options.threadId }),
    });
  } catch (error) {
    if (error instanceof KintoneRequestError && options.threadId === undefined) {
      throw new Error(
        `${error.message}\n` +
          "  スレッド ID の指定が必要な可能性があります。--thread <id> を付けて再実行してください。\n" +
          "  スレッド ID はスペースを開いたときの URL から読めます: /k/#/space/{スペースID}/thread/{スレッドID}",
      );
    }
    throw error;
  }
}

/** 運用環境への反映が完了するまで、指数バックオフで状況を確認し続ける。 */
export async function waitForDeployment(
  appId: string,
  kintone: AuthenticatedKintone,
  options: PollingOptions = {},
  report: (progress: DeployProgress) => void = () => {},
): Promise<void> {
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const startedAt = now();
  let delay = initialDelayMs;
  let attempt = 0;

  for (;;) {
    await sleep(delay);
    attempt += 1;

    const { apps } = await kintone.call((client) => client.app.getDeployStatus({ apps: [appId] }));
    const status = apps.find((entry) => String(entry.app) === String(appId))?.status;

    report({
      step: "polling",
      message: `反映状況: ${status ?? "不明"}`,
      detail: `${attempt} 回目の確認 (${Math.round((now() - startedAt) / 1000)} 秒経過)`,
    });

    if (status === "SUCCESS") return;
    if (status === "FAIL") {
      throw new Error(`運用環境への反映に失敗しました (アプリ ID: ${appId}, status: FAIL)`);
    }
    if (status === "CANCEL") {
      throw new Error(
        `運用環境への反映がキャンセルされました (アプリ ID: ${appId}, status: CANCEL)。` +
          " 同時に反映した別のアプリが失敗した可能性があります。",
      );
    }

    if (now() - startedAt >= timeoutMs) {
      throw new Error(
        `運用環境への反映が ${Math.round(timeoutMs / 1000)} 秒以内に完了しませんでした (アプリ ID: ${appId})。` +
          " kintone の画面で反映状況を確認してください。",
      );
    }
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

/** properties を指定件数ずつに分割する。フィールドの並び順は維持する。 */
export function chunk(
  properties: KintoneFieldProperties,
  size: number,
): KintoneFieldProperties[] {
  const entries = Object.entries(properties);
  if (entries.length === 0) return [];

  const chunks: KintoneFieldProperties[] = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(Object.fromEntries(entries.slice(index, index + size)));
  }
  return chunks;
}

async function revertQuietly(appId: string, kintone: AuthenticatedKintone): Promise<void> {
  try {
    await kintone.call((client) => client.app.deployApp({ apps: [{ app: appId }], revert: true }));
  } catch {
    // 破棄自体の失敗で元のエラーを覆い隠さない。アプリ ID は呼び出し元のメッセージに含まれる。
  }
}

function describe(prefix: string, error: unknown): string {
  if (!(error instanceof Error)) return `${prefix}: ${String(error)}`;

  const code = (error as { code?: unknown }).code;
  if (code === "CB_OA01") {
    // OAuth のスコープ不足。原文が "Cannot access protected resource" だけで
    // 何が足りないのか分からないため、対処を添える。
    return (
      `${prefix}: OAuth のスコープが不足しています (CB_OA01)。\n` +
      "  `vck login` を実行して認可をやり直してください。"
    );
  }

  const suffix = typeof code === "string" ? ` [${code}]` : "";
  return `${prefix}: ${error.message}${suffix}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 既存アプリから取得した設定。`vck pull` で使う。 */
export interface PulledApp {
  readonly spec: Record<string, unknown>;
  readonly warnings: readonly string[];
  readonly appId: string;
  readonly appName: string;
  /** 削除候補グループが既に在るか。二重に作らないために使う。 */
  readonly hasOrphanGroup: boolean;
  /** 既に削除候補グループへ移してあるフィールド。もう一度動かさないために使う。 */
  readonly parkedCodes: readonly string[];
}

/**
 * 既存アプリの設定を読み取って AppSpec に戻す。
 *
 * **読み取りしかしない。** kintone を一切変更しないので、いつ実行しても安全。
 * 運用環境の設定を見るため preview は使わない (動作テスト環境に未反映の変更は含めない)。
 */
export async function pullApp(
  appId: string,
  kintone: AuthenticatedKintone,
  options: {
    readonly onProgress?: (progress: DeployProgress) => void;
    /**
     * 動作テスト環境の設定を読むか。
     *
     * 既定で true。動作テスト環境は「運用環境 + まだ反映していない変更」なので、
     * 未反映の変更が無ければ運用環境と同じ内容になる。
     * ここを運用環境にすると、update を反映前に 2 回流したときに
     * 「もう追加済みのフィールドをまた追加しようとする」ことになる。
     */
    readonly preview?: boolean;
  } = {},
): Promise<PulledApp> {
  const report = options.onProgress ?? (() => {});
  const preview = options.preview !== false;

  report({ step: "createApp", message: `アプリ ${appId} の設定を取得しています` });

  const [settings, form, layout, views] = await Promise.all([
    kintone.call((client) => client.app.getAppSettings({ app: appId, preview })),
    kintone.call((client) => client.app.getFormFields({ app: appId, preview })),
    kintone.call((client) => client.app.getFormLayout({ app: appId, preview })),
    kintone.call((client) => client.app.getViews({ app: appId, preview })),
  ]);

  const pulled = toAppSpecFromKintone({
    name: settings.name,
    description: stripHtml(settings.description),
    theme: settings.theme,
    icon: settings.icon as { type?: string } | undefined,
    properties: form.properties as unknown as KintoneProperties,
    layout: layout.layout as unknown as Record<string, unknown>[],
    views: views.views as unknown as Record<string, Record<string, unknown>>,
    titleField: settings.titleField as { selectionMode?: string; code?: string },
    settings: settings as unknown as Record<string, unknown>,
  });

  report({
    step: "createApp",
    message: `「${settings.name}」を AppSpec にしました`,
    detail: `フィールド ${(pulled.spec["fields"] as unknown[]).length} 件 / 警告 ${pulled.warnings.length} 件`,
  });

  return {
    ...pulled,
    appId,
    appName: settings.name,
    hasOrphanGroup: Object.hasOwn(form.properties, ORPHAN_GROUP_CODE),
    parkedCodes: parkedFieldCodes(layout.layout as unknown as LayoutRow[]),
  };
}

/** 削除候補グループの中に居るフィールドコード。 */
function parkedFieldCodes(layout: readonly LayoutRow[]): string[] {
  const group = layout.find(
    (row) => row.type === "GROUP" && (row as { code?: string }).code === ORPHAN_GROUP_CODE,
  );
  if (group === undefined) return [];
  return collectLayoutFields(((group as { layout?: LayoutRow[] }).layout ?? []) as LayoutRow[]).map(
    (field) => field.code,
  );
}

/**
 * kintone のアプリ説明は HTML で返る。
 * AppSpec は素のテキストとして扱うので、タグを落として改行に均す。
 */
function stripHtml(html: string | undefined): string | undefined {
  if (html === undefined || html === "") return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    // kintone は全角括弧なども数値文字参照で返す (&#xff08; など)。
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? undefined : text;
}

/** 型変更のように、更新では実現できない要求。 */
export class UnsupportedUpdateError extends Error {
  constructor(
    message: string,
    readonly diff: AppDiff,
  ) {
    super(message);
    this.name = "UnsupportedUpdateError";
  }
}

export interface UpdateOptions {
  /** 運用環境まで反映するか。既定は false (動作テスト環境で止める)。 */
  readonly deploy?: boolean;
  readonly onProgress?: (progress: DeployProgress) => void;
  readonly polling?: PollingOptions;
}

export interface UpdateResult {
  readonly appId: string;
  readonly appName: string;
  readonly diff: AppDiff;
  readonly revision: string;
  /** 運用環境まで反映したか。 */
  readonly deployed: boolean;
  readonly warnings: readonly string[];
  /** 今回あらたに削除候補へ移したフィールド。 */
  readonly pendingOrphans: readonly string[];
}

/**
 * 既存アプリを AppSpec の内容に近づける。
 *
 * **既定では動作テスト環境で止める。** 更新は新規作成と違って壊しうるので、
 * kintone の画面で「変更を確認」してから人が反映を決められるようにする。
 *
 * 目標から消えたフィールドは**削除しない**。畳んだグループに移すだけで、データは残る。
 */
export async function updateApp(
  appId: string,
  desired: AppSpec,
  kintone: AuthenticatedKintone,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  const report = options.onProgress ?? (() => {});

  const pulled = await pullApp(appId, kintone, { onProgress: report });
  const current = parseAppSpec(pulled.spec);
  const diff = diffAppSpec(current, desired);

  if (diff.retyped.length > 0) {
    // kintone は作成後の型を変えられない。黙って飛ばすと spec と実物がずれる。
    const detail = diff.retyped
      .map((entry) => `    ${entry.code}: ${entry.from} → ${entry.to}`)
      .join("\n");
    throw new UnsupportedUpdateError(
      "kintone は作成後のフィールド型を変更できないため、この AppSpec は適用できません。\n" +
        `${detail}\n` +
        "  別のフィールドコードで新しいフィールドを作り、古い方は AppSpec から外してください" +
        " (外したフィールドは削除候補に移ります。データは残ります)。",
      diff,
    );
  }

  // 既に削除候補へ移してあるものは、もう動かす必要がない。
  const parked = new Set(pulled.parkedCodes);
  const orphanCodes = diff.orphaned
    .map((entry) => entry.code)
    .filter((code) => !parked.has(code));

  const nothingToDo =
    diff.added.length === 0 &&
    diff.updated.length === 0 &&
    diff.app.length === 0 &&
    diff.views.added.length === 0 &&
    diff.views.updated.length === 0 &&
    diff.views.removed.length === 0 &&
    !diff.layout.willApply &&
    orphanCodes.length === 0;

  if (nothingToDo) {
    return {
      appId,
      appName: pulled.appName,
      diff,
      revision: "-1",
      deployed: false,
      warnings: pulled.warnings,
      pendingOrphans: [],
    };
  }

  let revision = "-1";
  const needsOrphanGroup = orphanCodes.length > 0 && !pulled.hasOrphanGroup;

  // 追加するフィールド。削除候補グループもフィールドなので、無ければここで作る。
  const additions = toFieldProperties(diff.added.map((entry) => entry.field));
  if (needsOrphanGroup) {
    additions[ORPHAN_GROUP_CODE] = {
      type: "GROUP",
      code: ORPHAN_GROUP_CODE,
      label: ORPHAN_GROUP_LABEL,
      // 畳んだ状態にして、普段は目に入らないようにする。
      openGroup: false,
    };
  }

  if (Object.keys(additions).length > 0) {
    report({
      step: "addFields",
      message: `フィールドを ${Object.keys(additions).length} 件追加します`,
      detail: Object.keys(additions).join(", "),
    });
    const result = await kintone.call((client) =>
      client.app.addFormFields({ app: appId, properties: additions }),
    );
    revision = result.revision;
  }

  if (diff.updated.length > 0) {
    // 変わったフィールドだけを送る (この API は部分指定でよい)。
    const properties = toFieldProperties(diff.updated.map((entry) => entry.field));
    report({
      step: "addFields",
      message: `フィールドを ${diff.updated.length} 件変更します`,
      detail: diff.updated.map((entry) => entry.code).join(", "),
    });
    const result = await kintone.call((client) =>
      client.app.updateFormFields({ app: appId, properties, revision }),
    );
    revision = result.revision;
  }

  if (diff.app.length > 0) {
    const settings = toAppSettings(desired);
    if (settings !== null) {
      report({
        step: "updateSettings",
        message: "アプリの設定を変更します",
        detail: diff.app.map((change) => change.key).join(", "),
      });
      const result = await kintone.call((client) =>
        client.app.updateAppSettings({
          app: appId,
          revision,
          name: desired.name,
          ...settings,
        } as Parameters<KintoneRestAPIClient["app"]["updateAppSettings"]>[0]),
      );
      revision = result.revision;
    }
  }

  if (diff.views.added.length + diff.views.updated.length + diff.views.removed.length > 0) {
    report({
      step: "updateViews",
      message: "一覧を変更します",
      detail: `+${diff.views.added.length} ~${diff.views.updated.length} -${diff.views.removed.length}`,
    });
    const result = await kintone.call((client) =>
      client.app.updateViews({
        app: appId,
        revision,
        views: toViews(desired.views ?? []),
      } as Parameters<KintoneRestAPIClient["app"]["updateViews"]>[0]),
    );
    revision = result.revision;
  }

  if (orphanCodes.length > 0 || diff.layout.willApply) {
    {
      report({
        step: "updateLayout",
        message:
          orphanCodes.length > 0
            ? `${orphanCodes.length} 件のフィールドを削除候補へ移します`
            : "フォームの並びを組み直します",
        detail: orphanCodes.join(", "),
      });

      const layoutNow = await kintone.call((client) =>
        client.app.getFormLayout({ app: appId, preview: true }),
      );
      const layout = buildUpdatedLayout({
        current: layoutNow.layout as unknown as LayoutRow[],
        desired: desired.fields.map((field) => ({
          type: field.type,
          code: resolveFieldCode(field),
        })),
        orphans: orphanCodes,
        regroup: diff.layout.willApply,
        maxPerRow: resolveLayout(desired).maxPerRow,
        groups: fieldGroups(desired),
      });

      const result = await kintone.call((client) =>
        client.app.updateFormLayout({
          app: appId,
          revision,
          layout,
        } as Parameters<KintoneRestAPIClient["app"]["updateFormLayout"]>[0]),
      );
      revision = result.revision;
    }
  }

  if (options.deploy !== true) {
    report({
      step: "deploy",
      message: "動作テスト環境まで反映しました (運用環境へは反映していません)",
      detail: "kintone の画面で「変更を確認」してから、--deploy を付けて再実行してください",
    });
    return {
      appId,
      appName: pulled.appName,
      diff,
      revision,
      deployed: false,
      warnings: pulled.warnings,
      pendingOrphans: orphanCodes,
    };
  }

  report({ step: "deploy", message: "運用環境へ反映します", detail: `revision=${revision}` });
  await kintone.call((client) => client.app.deployApp({ apps: [{ app: appId, revision }] }));

  report({ step: "polling", message: "反映の完了を待っています" });
  await waitForDeployment(appId, kintone, options.polling, report);

  return {
    appId,
    appName: pulled.appName,
    diff,
    revision,
    deployed: true,
    warnings: pulled.warnings,
    pendingOrphans: orphanCodes,
  };
}

