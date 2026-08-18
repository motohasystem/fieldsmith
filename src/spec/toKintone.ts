import {
  BUILT_IN_FIELD_CODES,
  resolveFieldCode,
  type AppSpec,
  type GeneralSettings,
  type ViewSpec,
} from "./appSpec.js";
import { isOptionFieldType, type FieldSpec } from "./fieldSpec.js";

/** kintone のフィールド追加 API に渡す properties。 */
export type KintoneFieldProperties = Record<string, Record<string, unknown>>;

/** kintone の一覧変更 API に渡す views。 */
export type KintoneViews = Record<string, Record<string, unknown>>;

/** kintone の一般設定変更 API に渡すパラメータ (app / revision を除く)。 */
export type KintoneAppSettings = Record<string, unknown>;

/** AppSpec から kintone に送る全ペイロードをまとめたもの。--dry-run はこれをそのまま出力する。 */
export interface KintonePayloads {
  readonly appName: string;
  readonly properties: KintoneFieldProperties;
  readonly settings: KintoneAppSettings | null;
  readonly views: KintoneViews | null;
}

export function toKintonePayloads(spec: AppSpec): KintonePayloads {
  return {
    appName: spec.name,
    properties: toFieldProperties(spec.fields),
    settings: toAppSettings(spec),
    views: spec.views === undefined ? null : toViews(spec.views),
  };
}

/**
 * FieldSpec[] を kintone の properties に変換する。
 * properties のキーはフィールドコードと一致している必要がある。
 */
export function toFieldProperties(fields: readonly FieldSpec[]): KintoneFieldProperties {
  const properties: KintoneFieldProperties = {};
  for (const field of fields) {
    const code = resolveFieldCode(field);
    properties[code] = toFieldProperty(field, code);
  }
  return properties;
}

function toFieldProperty(field: FieldSpec, code: string): Record<string, unknown> {
  const property: Record<string, unknown> = {
    type: field.type,
    code,
    label: field.label,
  };

  setIfDefined(property, "required", field.required);
  setIfDefined(property, "unique", field.unique);
  setIfDefined(property, "noLabel", field.noLabel);

  if (isOptionFieldType(field.type)) {
    const optionField = field as Extract<FieldSpec, { options: string[] }>;
    property["options"] = toOptions(optionField.options);
    if (optionField.defaultValue !== undefined) {
      // kintone は複数選択系の defaultValue を配列で受け取る。
      const multiSelect = field.type === "CHECK_BOX" || field.type === "MULTI_SELECT";
      property["defaultValue"] = multiSelect
        ? toArray(optionField.defaultValue)
        : optionField.defaultValue;
    }
    return property;
  }

  switch (field.type) {
    case "SINGLE_LINE_TEXT":
      setIfDefined(property, "defaultValue", field.defaultValue);
      setIfDefined(property, "minLength", toStringOrUndefined(field.minLength));
      setIfDefined(property, "maxLength", toStringOrUndefined(field.maxLength));
      break;
    case "MULTI_LINE_TEXT":
    case "RICH_TEXT":
      setIfDefined(property, "defaultValue", field.defaultValue);
      break;
    case "NUMBER":
      setIfDefined(property, "defaultValue", toStringOrUndefined(field.defaultValue));
      setIfDefined(property, "minValue", toStringOrUndefined(field.minValue));
      setIfDefined(property, "maxValue", toStringOrUndefined(field.maxValue));
      setIfDefined(property, "digit", field.digit);
      setIfDefined(property, "displayScale", toStringOrUndefined(field.displayScale));
      setIfDefined(property, "unit", field.unit);
      setIfDefined(property, "unitPosition", field.unitPosition);
      break;
    case "CALC":
      property["expression"] = field.expression;
      setIfDefined(property, "format", field.format);
      setIfDefined(property, "displayScale", toStringOrUndefined(field.displayScale));
      setIfDefined(property, "unit", field.unit);
      setIfDefined(property, "unitPosition", field.unitPosition);
      setIfDefined(property, "hideExpression", field.hideExpression);
      break;
    case "DATE":
    case "TIME":
    case "DATETIME":
      setIfDefined(property, "defaultNowValue", field.defaultNowValue);
      setIfDefined(property, "defaultValue", field.defaultValue);
      break;
    case "LINK":
      property["protocol"] = field.protocol;
      setIfDefined(property, "defaultValue", field.defaultValue);
      setIfDefined(property, "maxLength", toStringOrUndefined(field.maxLength));
      break;
    case "USER_SELECT":
    case "ORGANIZATION_SELECT":
    case "GROUP_SELECT":
      setIfDefined(property, "entities", field.entities);
      setIfDefined(property, "defaultValue", field.defaultValue);
      break;
    case "FILE":
      setIfDefined(property, "thumbnailSize", field.thumbnailSize);
      break;
  }

  return property;
}

/**
 * 選択肢の配列を kintone の options 形式に変換する。
 * kintone は `{ ラベル: { label, index } }` を要求し、index は文字列でなければならない。
 */
export function toOptions(options: readonly string[]): Record<string, { label: string; index: string }> {
  const result: Record<string, { label: string; index: string }> = {};
  options.forEach((label, index) => {
    result[label] = { label, index: String(index) };
  });
  return result;
}

/** 一般設定・アプリ説明・テーマを kintone の一般設定変更 API のパラメータに変換する。 */
export function toAppSettings(spec: AppSpec): KintoneAppSettings | null {
  const settings: KintoneAppSettings = {};

  setIfDefined(settings, "description", spec.description);
  setIfDefined(settings, "theme", spec.theme);

  const general: GeneralSettings | undefined = spec.settings;
  if (general !== undefined) {
    if (general.titleFieldCode !== undefined) {
      settings["titleField"] = { selectionMode: "MANUAL", code: general.titleFieldCode };
    }
    setIfDefined(settings, "enableComments", general.enableComments);
    setIfDefined(settings, "enableThumbnails", general.enableThumbnails);
    setIfDefined(settings, "enableBulkDeletion", general.enableBulkDeletion);
    setIfDefined(settings, "enableDuplicateRecord", general.enableDuplicateRecord);
    setIfDefined(settings, "enableInlineRecordEditing", general.enableInlineRecordEditing);
    setIfDefined(
      settings,
      "firstMonthOfFiscalYear",
      toStringOrUndefined(general.firstMonthOfFiscalYear),
    );
  }

  return Object.keys(settings).length > 0 ? settings : null;
}

/**
 * ViewSpec[] を kintone の views 形式に変換する。
 * views のキーは一覧名で、index は表示順を表す文字列。
 */
export function toViews(views: readonly ViewSpec[]): KintoneViews {
  const result: KintoneViews = {};
  views.forEach((view, index) => {
    const entry: Record<string, unknown> = {
      index: String(index),
      type: view.type,
      name: view.name,
    };
    if (view.type === "LIST") {
      setIfDefined(entry, "fields", view.fields);
    } else {
      setIfDefined(entry, "date", view.date);
      setIfDefined(entry, "title", view.title);
    }
    setIfDefined(entry, "filterCond", view.filterCond);
    setIfDefined(entry, "sort", view.sort);
    setIfDefined(entry, "pager", view.pager);
    setIfDefined(entry, "device", view.device);
    result[view.name] = entry;
  });
  return result;
}

/** 一覧の fields に指定できるフィールドコードの集合 (spec 由来 + 組み込み)。 */
export function selectableFieldCodes(spec: AppSpec): Set<string> {
  const codes = new Set(BUILT_IN_FIELD_CODES);
  for (const field of spec.fields) {
    codes.add(resolveFieldCode(field));
  }
  return codes;
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function toStringOrUndefined(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}
