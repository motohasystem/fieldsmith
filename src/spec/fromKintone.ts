import { SUPPORTED_FIELD_TYPES, type SupportedFieldType } from "./fieldSpec.js";

/**
 * kintone から取得したアプリ設定を AppSpec に戻す。
 *
 * `toKintone.ts` の逆向き。既存アプリを AppSpec 化して、
 * 複製・別環境への展開・更新の起点にするために使う。
 *
 * **すべてを表現できるわけではない。** AppSpec が扱わない設定
 * (テーブル、ルックアップ、関連レコード一覧、細かなレイアウト) は落ちる。
 * 黙って捨てると「取得した spec をデプロイしたら別物ができた」となるので、
 * 落としたものは必ず warnings として返す。
 */

export interface PulledSpec {
  /** そのまま `fieldsmith deploy` に渡せる AppSpec。 */
  readonly spec: Record<string, unknown>;
  /** 表現しきれずに落とした設定。人にも機械にも見せる。 */
  readonly warnings: readonly string[];
}

/** kintone のフィールド設定 (getFormFields の properties)。 */
export type KintoneProperties = Record<string, Record<string, unknown>>;

/** アプリ作成時に自動で用意されるので、AppSpec には書かないフィールド型。 */
const AUTO_FIELD_TYPES = new Set([
  "RECORD_NUMBER",
  "CREATOR",
  "CREATED_TIME",
  "MODIFIER",
  "UPDATED_TIME",
  "STATUS",
  "STATUS_ASSIGNEE",
  "CATEGORY",
]);

const SUPPORTED = new Set<string>(SUPPORTED_FIELD_TYPES);

export interface PullInput {
  readonly name: string;
  /** getAppSettings の icon。画像アイコンは AppSpec に戻せないため警告に使う。 */
  readonly icon?: { readonly type?: string } | undefined;
  readonly description?: string | undefined;
  readonly theme?: string | undefined;
  readonly properties: KintoneProperties;
  /** getFormLayout の layout。フィールドの並び順を決めるのに使う。 */
  readonly layout?: readonly Record<string, unknown>[] | undefined;
  readonly views?: Record<string, Record<string, unknown>> | undefined;
  readonly titleField?: { selectionMode?: string; code?: string } | undefined;
  readonly settings?: Record<string, unknown> | undefined;
}

export function toAppSpecFromKintone(input: PullInput): PulledSpec {
  const warnings: string[] = [];
  const order = fieldOrderFromLayout(input.layout ?? []);

  const entries = Object.entries(input.properties)
    .filter(([, property]) => {
      const type = String(property["type"]);
      if (AUTO_FIELD_TYPES.has(type)) return false;
      if (!SUPPORTED.has(type)) {
        warnings.push(
          `フィールド「${property["label"] ?? property["code"]}」(${type}) は AppSpec で表現できないため除きました。` +
            " デプロイし直しても、このフィールドは作られません。",
        );
        return false;
      }
      return true;
    })
    // レイアウト上の位置で並べる。レイアウトに無いものは末尾へ。
    .sort(([codeA], [codeB]) => {
      const a = order.get(codeA) ?? Number.MAX_SAFE_INTEGER;
      const b = order.get(codeB) ?? Number.MAX_SAFE_INTEGER;
      return a - b;
    });

  const spec: Record<string, unknown> = {
    name: input.name,
    // レイアウトは AppSpec では再現しきれないため、既存の並びには手を触れない。
    layout: "stacked",
    fields: entries.map(([, property]) => toFieldSpec(property)),
  };

  assign(spec, "description", input.description);
  assign(spec, "theme", input.theme);

  // アイコンは kintone からは画像として返るので、絵文字や頭文字には戻せない。
  // 既定の組込みアイコンは指定していないのと同じなので、画像のときだけ知らせる。
  if (input.icon?.type === "FILE") {
    warnings.push(
      "アプリアイコンに画像が設定されていますが、AppSpec には含められません。" +
        ' 必要なら icon に絵文字か頭文字を書いてください (例: "icon": "💼")。',
    );
  }

  const views = input.views === undefined ? [] : toViewSpecs(input.views, warnings);
  if (views.length > 0) spec["views"] = views;

  const settings = toSettings(input);
  if (settings !== null) spec["settings"] = settings;

  return { spec, warnings };
}

/** レイアウトを辿って、フィールドコード → 並び順を作る。 */
function fieldOrderFromLayout(layout: readonly Record<string, unknown>[]): Map<string, number> {
  const order = new Map<string, number>();
  let index = 0;

  const walk = (rows: readonly Record<string, unknown>[]): void => {
    for (const row of rows) {
      const fields = row["fields"];
      if (Array.isArray(fields)) {
        for (const field of fields as { code?: string }[]) {
          if (typeof field.code === "string") order.set(field.code, index++);
        }
      }
      const nested = row["layout"];
      if (Array.isArray(nested)) walk(nested as Record<string, unknown>[]);
    }
  };

  walk(layout);
  return order;
}

function toFieldSpec(property: Record<string, unknown>): Record<string, unknown> {
  const type = String(property["type"]) as SupportedFieldType;
  const field: Record<string, unknown> = {
    type,
    label: String(property["label"] ?? property["code"]),
    code: String(property["code"]),
  };

  assignTrue(field, "required", property["required"]);
  assignTrue(field, "unique", property["unique"]);
  assignTrue(field, "noLabel", property["noLabel"]);

  const options = property["options"];
  if (isRecord(options)) {
    field["options"] = optionLabelsInOrder(options);
    const defaultValue = property["defaultValue"];
    if (typeof defaultValue === "string" && defaultValue !== "") {
      field["defaultValue"] = defaultValue;
    } else if (Array.isArray(defaultValue) && defaultValue.length > 0) {
      field["defaultValue"] = defaultValue;
    }
    return field;
  }

  switch (type) {
    case "SINGLE_LINE_TEXT":
      assignText(field, "defaultValue", property["defaultValue"]);
      assignNumeric(field, "minLength", property["minLength"]);
      assignNumeric(field, "maxLength", property["maxLength"]);
      break;
    case "MULTI_LINE_TEXT":
    case "RICH_TEXT":
      assignText(field, "defaultValue", property["defaultValue"]);
      break;
    case "NUMBER":
      assignText(field, "defaultValue", property["defaultValue"]);
      assignText(field, "minValue", property["minValue"]);
      assignText(field, "maxValue", property["maxValue"]);
      assignTrue(field, "digit", property["digit"]);
      assignNumeric(field, "displayScale", property["displayScale"]);
      assignText(field, "unit", property["unit"]);
      assignText(field, "unitPosition", property["unitPosition"]);
      break;
    case "CALC":
      field["expression"] = String(property["expression"] ?? "");
      assignText(field, "format", property["format"]);
      assignNumeric(field, "displayScale", property["displayScale"]);
      assignText(field, "unit", property["unit"]);
      assignText(field, "unitPosition", property["unitPosition"]);
      assignTrue(field, "hideExpression", property["hideExpression"]);
      break;
    case "DATE":
    case "TIME":
    case "DATETIME":
      assignTrue(field, "defaultNowValue", property["defaultNowValue"]);
      assignText(field, "defaultValue", property["defaultValue"]);
      break;
    case "LINK":
      assignText(field, "protocol", property["protocol"]);
      assignText(field, "defaultValue", property["defaultValue"]);
      assignNumeric(field, "maxLength", property["maxLength"]);
      break;
    case "USER_SELECT":
    case "ORGANIZATION_SELECT":
    case "GROUP_SELECT":
      assignArray(field, "entities", property["entities"]);
      assignArray(field, "defaultValue", property["defaultValue"]);
      break;
    case "FILE":
      assignText(field, "thumbnailSize", property["thumbnailSize"]);
      break;
  }

  return field;
}

/** 選択肢は index の順に並べ直す (kintone はオブジェクトで返すため順序が保証されない)。 */
function optionLabelsInOrder(options: Record<string, unknown>): string[] {
  return Object.values(options)
    .filter(isRecord)
    .sort((a, b) => Number(a["index"] ?? 0) - Number(b["index"] ?? 0))
    .map((option) => String(option["label"]));
}

function toViewSpecs(
  views: Record<string, Record<string, unknown>>,
  warnings: string[],
): Record<string, unknown>[] {
  return Object.values(views)
    .filter((view) => {
      const type = String(view["type"]);
      if (type === "LIST" || type === "CALENDAR") return true;
      warnings.push(
        `一覧「${view["name"]}」(${type}) は AppSpec で表現できないため除きました。`,
      );
      return false;
    })
    .sort((a, b) => Number(a["index"] ?? 0) - Number(b["index"] ?? 0))
    .map((view) => {
      const spec: Record<string, unknown> = {
        name: String(view["name"]),
        type: String(view["type"]),
      };
      assignArray(spec, "fields", view["fields"]);
      assignText(spec, "date", view["date"]);
      assignText(spec, "title", view["title"]);
      assignText(spec, "filterCond", view["filterCond"]);
      assignText(spec, "sort", view["sort"]);
      return spec;
    });
}

function toSettings(input: PullInput): Record<string, unknown> | null {
  const settings: Record<string, unknown> = {};
  const source = input.settings ?? {};

  if (input.titleField?.selectionMode === "MANUAL" && input.titleField.code !== undefined) {
    settings["titleFieldCode"] = input.titleField.code;
  }
  for (const key of [
    "enableComments",
    "enableThumbnails",
    "enableBulkDeletion",
    "enableDuplicateRecord",
    "enableInlineRecordEditing",
  ]) {
    if (source[key] === true) settings[key] = true;
  }
  const firstMonth = source["firstMonthOfFiscalYear"];
  if (firstMonth !== undefined && Number(firstMonth) !== 1) {
    settings["firstMonthOfFiscalYear"] = Number(firstMonth);
  }

  return Object.keys(settings).length > 0 ? settings : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") target[key] = value;
}

/** kintone は「設定なし」を空文字で返すことがあるので、それは書かない。 */
function assignText(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string" && value !== "") target[key] = value;
}

/** kintone は数値も文字列で返す。AppSpec 側は数値を受けるので戻す。 */
function assignNumeric(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) target[key] = parsed;
}

function assignTrue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === true) target[key] = true;
}

function assignArray(target: Record<string, unknown>, key: string, value: unknown): void {
  if (Array.isArray(value) && value.length > 0) target[key] = value;
}
