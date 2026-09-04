import { z } from "zod";

/**
 * v1 で追加をサポートするフィールド型。
 * kintone のフィールド型のうち、フィールド追加 API で扱えて、かつネストを含まないものに限定している。
 */
export const SUPPORTED_FIELD_TYPES = [
  "SINGLE_LINE_TEXT",
  "MULTI_LINE_TEXT",
  "RICH_TEXT",
  "NUMBER",
  "CALC",
  "RADIO_BUTTON",
  "CHECK_BOX",
  "MULTI_SELECT",
  "DROP_DOWN",
  "DATE",
  "TIME",
  "DATETIME",
  "LINK",
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT",
  "FILE",
] as const;

export type SupportedFieldType = (typeof SUPPORTED_FIELD_TYPES)[number];

/** 選択肢 (options) を必須とするフィールド型。 */
export const OPTION_FIELD_TYPES = [
  "RADIO_BUTTON",
  "CHECK_BOX",
  "MULTI_SELECT",
  "DROP_DOWN",
] as const satisfies readonly SupportedFieldType[];

/**
 * フィールド追加 API では追加できない型。
 * ここに該当する指定は API を呼ぶ前にエラーにして、理由を伝える。
 */
export const UNADDABLE_FIELD_TYPES: Record<string, string> = {
  STATUS: "プロセス管理の設定で追加されるフィールドのため、フィールド追加 API では追加できません",
  ASSIGNEE: "プロセス管理の設定で追加されるフィールドのため、フィールド追加 API では追加できません",
  CATEGORY: "カテゴリーの設定で追加されるフィールドのため、フィールド追加 API では追加できません",
  RECORD_NUMBER: "アプリ作成時に自動生成されるフィールドのため、追加できません",
  CREATOR: "アプリ作成時に自動生成されるフィールドのため、追加できません",
  CREATED_TIME: "アプリ作成時に自動生成されるフィールドのため、追加できません",
  MODIFIER: "アプリ作成時に自動生成されるフィールドのため、追加できません",
  UPDATED_TIME: "アプリ作成時に自動生成されるフィールドのため、追加できません",
  SUBTABLE: "テーブルは v1 では未対応です",
  REFERENCE_TABLE: "関連レコード一覧は v1 では未対応です",
  // グループは fields に書くものではなく、layout: "sections" と field.group から
  // fieldsmith が組み立てる。中に何が入るかはレイアウトの話なので、
  // フィールドの列挙とは別の場所で表現したほうが読みやすい。
  GROUP: 'グループは fields に書かず、layout: "sections" と各フィールドの group で指定してください',
  // ルックアップだけは外している理由が他と違う。テーブルと関連レコード一覧が
  // アプリ内で完結する構造物なのに対し、ルックアップは他のアプリに依存する。
  //
  //   1. 設定に相手アプリの ID が要る。spec に書くと特定の kintone 環境でしか
  //      使えなくなり、「同じ spec を別の環境にもう 1 つ」ができなくなる。
  //      space を examples/ の spec に持たせていないのと同じ理由。
  //   2. 相手アプリが先に存在している必要があるため、deploy の
  //      「AppSpec 1 つ → アプリ 1 つ」という決定性が保てない。加えて
  //      --dry-run は kintone に接続しないので相手アプリを検証できず、
  //      「検証は通ったのにデプロイ中に落ちる」型の失敗になる。
  //
  // アプリ間の参照は AppSpec の外に置き、kintone 上で人が繋ぐ前提。
  // @see README.md「ルックアップを対象外にしている理由」
  LOOKUP: "ルックアップは v1 では未対応です",
};

/**
 * kintone のフィールドコードで使えない文字。
 * 半角記号のうち使用できるのは `_` `･` `＿` 等に限られるため、実質的に禁止文字を列挙して弾く。
 * @see https://jp.cybozu.help/k/ja/user/app_settings/form/autocalc/fieldcode.html
 */
const FORBIDDEN_CODE_CHARS = /[ 　:：;；,，.。'"’”\/\\[\]{}()（）\-＝=+*<>!?@#$%^&|~`\t\n]/;

/** 予約語 (フィールドコードとして使用できない文字列)。 */
const RESERVED_FIELD_CODES = new Set([
  "ステータス",
  "作業者",
  "カテゴリー",
  "レコード番号",
  "作成者",
  "作成日時",
  "更新者",
  "更新日時",
  "Status",
  "Assignee",
  "Category",
  "Record_number",
]);

export interface FieldCodeIssue {
  readonly code: string;
  readonly reason: string;
}

/** フィールドコードが kintone の規約を満たすか検査する。問題がなければ null を返す。 */
export function validateFieldCode(code: string): FieldCodeIssue | null {
  if (code.length === 0) {
    return { code, reason: "フィールドコードが空です" };
  }
  if (code.length > 128) {
    return { code, reason: "フィールドコードは 128 文字以内である必要があります" };
  }
  if (/^[0-9０-９]/.test(code)) {
    return { code, reason: "フィールドコードの先頭に数字は使用できません" };
  }
  const forbidden = FORBIDDEN_CODE_CHARS.exec(code);
  if (forbidden) {
    return {
      code,
      reason: `フィールドコードに使用できない文字 ${JSON.stringify(forbidden[0])} が含まれています`,
    };
  }
  if (RESERVED_FIELD_CODES.has(code)) {
    return { code, reason: "予約語のためフィールドコードとして使用できません" };
  }
  return null;
}

/**
 * ラベルからフィールドコードを導出する。
 * kintone は日本語のフィールドコードを許容するため、禁止文字を `_` に置き換えるだけで足りる。
 */
export function deriveFieldCode(label: string): string {
  const replaced = label
    .split("")
    .map((ch) => (FORBIDDEN_CODE_CHARS.test(ch) ? "_" : ch))
    .join("")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = replaced.length > 0 ? replaced : "field";
  return /^[0-9０-９]/.test(base) ? `f_${base}` : base;
}

const codeSchema = z
  .string()
  .min(1)
  .max(128)
  .superRefine((value, ctx) => {
    const issue = validateFieldCode(value);
    if (issue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.reason });
    }
  });

const baseFieldShape = {
  /** フィールドコード。省略時は label から導出する。 */
  code: codeSchema.optional(),
  /** フィールド名。 */
  label: z.string({ required_error: "label (フィールド名) は必須です" }).min(1).max(128),
  /** 必須項目にするか。 */
  required: z.boolean().optional(),
  /** 値の重複を禁止するか。 */
  unique: z.boolean().optional(),
  /** フィールド名を表示しない。 */
  noLabel: z.boolean().optional(),
  /**
   * 意味のまとまりの名前 (「書誌情報」「貸出」など)。
   *
   * `layout` の指定で扱いが変わる。
   *   - `grouped`  : 同じ名前のフィールドを横に並べる (kintone には送らない)
   *   - `sections` : 同じ名前のフィールドを 1 つの**グループフィールド**に入れる
   *
   * `sections` ではこの名前がグループのフィールドコードの元になるため、
   * 上限はフィールドコードに合わせる。
   */
  group: z.string().min(1).max(128).optional(),
};

const optionsSchema = z
  .array(z.string().min(1).max(128), {
    // キーごと無い場合、既定では英語の "Required" になる。直し方が伝わらないので置き換える。
    required_error: '選択肢を options に配列で指定してください (例: ["高", "中", "低"])',
    invalid_type_error: '選択肢は文字列の配列で指定してください (例: ["高", "中", "低"])',
  })
  .min(1, "選択肢を 1 つ以上指定してください")
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    for (const option of options) {
      if (seen.has(option)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `選択肢 "${option}" が重複しています`,
        });
      }
      seen.add(option);
    }
  });

const plainField = <T extends SupportedFieldType>(type: T) =>
  z.object({ ...baseFieldShape, type: z.literal(type) }).strict();

const optionField = <T extends SupportedFieldType>(type: T) =>
  z
    .object({
      ...baseFieldShape,
      type: z.literal(type),
      options: optionsSchema,
      /** 既定で選択される選択肢。options に含まれる値である必要がある。 */
      defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .strict();

const selectEntitySchema = z
  .object({
    type: z.enum(["USER", "GROUP", "ORGANIZATION", "FUNCTION"]),
    code: z.string().min(1),
  })
  .strict();

const entityField = <T extends SupportedFieldType>(type: T) =>
  z
    .object({
      ...baseFieldShape,
      type: z.literal(type),
      /** 選択肢に含める対象を絞り込む。省略時は全員が選択できる。 */
      entities: z.array(selectEntitySchema).optional(),
      /** 既定値として設定するユーザー/組織/グループ。 */
      defaultValue: z.array(selectEntitySchema).optional(),
    })
    .strict();

const fieldSpecObjectSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...baseFieldShape,
      type: z.literal("SINGLE_LINE_TEXT"),
      defaultValue: z.string().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("MULTI_LINE_TEXT"),
      defaultValue: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("RICH_TEXT"),
      defaultValue: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("NUMBER"),
      defaultValue: z.union([z.string(), z.number()]).optional(),
      minValue: z.union([z.string(), z.number()]).optional(),
      maxValue: z.union([z.string(), z.number()]).optional(),
      /** 桁区切りを表示するか。 */
      digit: z.boolean().optional(),
      /** 小数点以下の表示桁数。 */
      displayScale: z.number().int().min(0).max(10).optional(),
      /** 数値の後ろに付ける単位。 */
      unit: z.string().max(64).optional(),
      unitPosition: z.enum(["BEFORE", "AFTER"]).optional(),
    })
    .strict(),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("CALC"),
      /** 計算式。フィールドコードを使って記述する。 */
      expression: z.string({
        required_error: "CALC には計算式を expression に指定してください (例: 単価 * 数量)",
      }).min(1, "CALC には計算式を expression に指定してください (例: 単価 * 数量)"),
      format: z
        .enum(["NUMBER", "NUMBER_DIGIT", "DATETIME", "DATE", "TIME", "HOUR_MINUTE", "DAY_HOUR_MINUTE"])
        .optional(),
      displayScale: z.number().int().min(0).max(10).optional(),
      unit: z.string().max(64).optional(),
      unitPosition: z.enum(["BEFORE", "AFTER"]).optional(),
      hideExpression: z.boolean().optional(),
    })
    .strict(),
  optionField("RADIO_BUTTON"),
  optionField("CHECK_BOX"),
  optionField("MULTI_SELECT"),
  optionField("DROP_DOWN"),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("DATE"),
      /** 今日の日付を既定値にする。 */
      defaultNowValue: z.boolean().optional(),
      defaultValue: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("TIME"),
      defaultNowValue: z.boolean().optional(),
      defaultValue: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("DATETIME"),
      defaultNowValue: z.boolean().optional(),
      defaultValue: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("LINK"),
      /** リンクの種類。 */
      protocol: z.enum(["WEB", "MAIL", "CALL"]).default("WEB"),
      defaultValue: z.string().optional(),
      maxLength: z.number().int().positive().optional(),
    })
    .strict(),
  entityField("USER_SELECT"),
  entityField("ORGANIZATION_SELECT"),
  entityField("GROUP_SELECT"),
  z
    .object({
      ...baseFieldShape,
      type: z.literal("FILE"),
      /** 添付できるファイルサイズの上限 (例: "10" = 10MB)。 */
      thumbnailSize: z.enum(["50", "150", "250", "500"]).optional(),
    })
    .strict(),
]);

/**
 * フィールド 1 件のスキーマ。
 * 型ごとのクロスフィールド検証 (defaultValue が options に含まれるか等) は、
 * discriminatedUnion のメンバーが ZodObject でなければならない制約のため union レベルで行う。
 */
export const fieldSpecSchema = fieldSpecObjectSchema.superRefine((field, ctx) => {
  if (
    field.type === "SINGLE_LINE_TEXT" &&
    field.minLength !== undefined &&
    field.maxLength !== undefined &&
    field.minLength > field.maxLength
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minLength"],
      message: "minLength が maxLength を超えています",
    });
  }

  if (isOptionFieldType(field.type)) {
    const optionField = field as Extract<FieldSpecObject, { options: string[] }>;
    const defaults =
      optionField.defaultValue === undefined
        ? []
        : Array.isArray(optionField.defaultValue)
          ? optionField.defaultValue
          : [optionField.defaultValue];

    for (const value of defaults) {
      if (value !== "" && !optionField.options.includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["defaultValue"],
          message: `defaultValue "${value}" が options に含まれていません`,
        });
      }
    }

    const singleSelect = field.type === "RADIO_BUTTON" || field.type === "DROP_DOWN";
    if (singleSelect && Array.isArray(optionField.defaultValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: `${field.type} の defaultValue は文字列で指定してください`,
      });
    }
  }
});

type FieldSpecObject = z.infer<typeof fieldSpecObjectSchema>;

export function isOptionFieldType(type: string): boolean {
  return (OPTION_FIELD_TYPES as readonly string[]).includes(type);
}

export type FieldSpec = z.infer<typeof fieldSpecSchema>;

/** フィールド型ごとに指定できるキー。`fieldsmith schema` の出力に使う。 */
export interface FieldTypeReference {
  readonly type: SupportedFieldType;
  readonly keys: readonly { readonly name: string; readonly required: boolean }[];
}

/**
 * 対応フィールド型と、それぞれに指定できるキーの一覧を Zod のスキーマから導出する。
 *
 * 手で書いた表は必ず実装とずれるので、定義そのものから引き出す。
 */
export function describeFieldTypes(): FieldTypeReference[] {
  return fieldSpecObjectSchema.options.map((member) => {
    const shape = member.shape as Record<string, z.ZodTypeAny>;
    const keys = Object.keys(shape)
      .filter((name) => name !== "type")
      .map((name) => ({ name, required: !shape[name]!.isOptional() }))
      // 必須を先に、その中では定義順を保つ。
      .sort((a, b) => Number(b.required) - Number(a.required));

    return {
      type: (shape["type"] as z.ZodLiteral<SupportedFieldType>).value,
      keys,
    };
  });
}
