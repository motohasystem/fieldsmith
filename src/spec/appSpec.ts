import { z } from "zod";
import { DEFAULT_MAX_PER_ROW, sectionCodeOf } from "./layout.js";
import {
  deriveFieldCode,
  fieldSpecSchema,
  UNADDABLE_FIELD_TYPES,
  validateFieldCode,
  type FieldSpec,
} from "./fieldSpec.js";

export const APP_THEMES = [
  "WHITE",
  "RED",
  "GREEN",
  "BLUE",
  "YELLOW",
  "BLACK",
] as const;

/** 一覧 (ビュー) の定義。v1 は一覧形式とカレンダー形式のみ扱う。 */
export const viewSpecSchema = z
  .object({
    /** 一覧の名前。64 文字以内。 */
    name: z.string().min(1).max(64),
    type: z.enum(["LIST", "CALENDAR"]).default("LIST"),
    /** LIST のとき表示するフィールドコード。省略時は全フィールドを表示する。 */
    fields: z.array(z.string().min(1)).optional(),
    /** CALENDAR のとき日付として使うフィールドコード。 */
    date: z.string().min(1).optional(),
    /** CALENDAR のときタイトルとして使うフィールドコード。 */
    title: z.string().min(1).optional(),
    /** 絞り込み条件 (kintone のクエリ形式)。例: `状態 in ("対応中")` */
    filterCond: z.string().optional(),
    /** 並び順 (kintone のクエリ形式)。例: `更新日時 desc` */
    sort: z.string().optional(),
    /** ページネーションを有効にするか。 */
    pager: z.boolean().optional(),
    device: z.enum(["DESKTOP", "ANY"]).optional(),
  })
  .strict();

export type ViewSpec = z.infer<typeof viewSpecSchema>;

/** アプリの一般設定。 */
export const generalSettingsSchema = z
  .object({
    /** レコードのタイトルに使うフィールドコード。省略時は kintone の自動選択。 */
    titleFieldCode: z.string().min(1).optional(),
    enableComments: z.boolean().optional(),
    enableThumbnails: z.boolean().optional(),
    enableBulkDeletion: z.boolean().optional(),
    enableDuplicateRecord: z.boolean().optional(),
    enableInlineRecordEditing: z.boolean().optional(),
    /** 年度の開始月 (1-12)。 */
    firstMonthOfFiscalYear: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

const appSpecObjectSchema = z
  .object({
    /** アプリ名。kintone の上限に合わせて 64 文字以内。 */
    name: z.string().min(1).max(64),
    /** アプリの説明。kintone の上限に合わせて 10,000 文字以内。 */
    description: z.string().max(10000).optional(),
    theme: z.enum(APP_THEMES).optional(),
    /**
     * アプリアイコンにする絵文字、または頭文字 (1〜3 文字)。
     * 画像を生成してアップロードし、アプリアイコンとして設定する。
     * 省略した場合はアイコンを設定しない (kintone の既定アイコンのまま)。
     */
    icon: z.string().min(1).refine((value) => [...value].length <= 8, {
      message: "icon は絵文字 1 文字か、短い頭文字で指定してください",
    }).optional(),
    /**
     * アプリを作成するスペース ID。省略するとスペースに属さないアプリになる。
     * CLI の --space を付けるとこちらより優先される。
     */
    space: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    /** スペース内のスレッド ID。kintone がスレッドの指定を求める場合に使う。 */
    thread: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    /** ゲストスペース ID。ゲストスペースのアプリは API のパスが変わる。 */
    guestSpaceId: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    /** アイコンの背景色 (#rrggbb)。省略時はアプリ名から決まる。 */
    iconBackground: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "iconBackground は #rrggbb 形式で指定してください")
      .optional(),
    /** フィールド。配列の順序がそのままフォームの配置順になる。 */
    fields: z.array(fieldSpecSchema).min(1, "フィールドを 1 つ以上指定してください"),
    /**
     * フォームの並べ方。
     * `grouped` (既定) は、似た系統のフィールドを横に並べる。
     * `sections` は、それに加えて同じ `group` のフィールドを
     * kintone のグループフィールドにまとめる。
     * `stacked` はレイアウトに手を加えず、1 行 1 フィールドのままにする。
     */
    layout: z
      .union([
        z.enum(["grouped", "stacked", "sections"]),
        z
          .object({
            mode: z.enum(["grouped", "stacked", "sections"]).default("grouped"),
            /** 1 行に並べる上限。 */
            maxPerRow: z.number().int().min(1).max(4).default(DEFAULT_MAX_PER_ROW),
          })
          .strict(),
      ])
      .optional(),
    /** 一覧。省略した場合は既定の一覧に手を加えない。 */
    views: z.array(viewSpecSchema).optional(),
    settings: generalSettingsSchema.optional(),
  })
  .strict();

/**
 * AppSpec のスキーマ。
 * フィールドコードの重複や、一覧・一般設定から参照されるフィールドコードの存在確認まで含めて、
 * kintone に 1 リクエストも投げる前に検出する。
 */
export const appSpecSchema = appSpecObjectSchema.superRefine((spec, ctx) => {
  const codes = new Set<string>();

  spec.fields.forEach((field, index) => {
    const code = resolveFieldCode(field);
    const issue = validateFieldCode(code);
    if (issue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", index, field.code === undefined ? "label" : "code"],
        message:
          field.code === undefined
            ? `label から導出したフィールドコード "${code}" が不正です: ${issue.reason}`
            : issue.reason,
      });
      return;
    }
    if (codes.has(code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", index, "code"],
        message: `フィールドコード "${code}" が重複しています`,
      });
    }
    codes.add(code);
  });

  spec.views?.forEach((view, index) => {
    const referenced: Array<[string, string | undefined]> = [
      ["date", view.date],
      ["title", view.title],
    ];
    for (const [key, code] of referenced) {
      if (code !== undefined && !codes.has(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["views", index, key],
          message: `フィールドコード "${code}" は fields に存在しません`,
        });
      }
    }
    view.fields?.forEach((code, fieldIndex) => {
      if (!codes.has(code) && !BUILT_IN_FIELD_CODES.has(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["views", index, "fields", fieldIndex],
          message: `フィールドコード "${code}" は fields に存在しません`,
        });
      }
    });
    if (view.type === "CALENDAR" && view.date === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["views", index, "date"],
        message: "CALENDAR 形式の一覧には date が必要です",
      });
    }
  });

  // 計算式が存在しないフィールドを参照していないか。
  // 一覧の参照は見ているのに式を見ないと、フィールドを消したときに素通りしてしまう。
  spec.fields.forEach((field, index) => {
    if (field.type !== "CALC") return;
    for (const reference of fieldReferencesIn(field.expression)) {
      if (!codes.has(reference) && !BUILT_IN_FIELD_CODES.has(reference)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", index, "expression"],
          message: `計算式が参照している "${reference}" は fields に存在しません`,
        });
      }
    }
  });

  const titleFieldCode = spec.settings?.titleFieldCode;
  if (titleFieldCode !== undefined && !codes.has(titleFieldCode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["settings", "titleFieldCode"],
      message: `フィールドコード "${titleFieldCode}" は fields に存在しません`,
    });
  }

  // 同じ group が離れて書かれていると、まとまらずに散らばった行になる。
  // 気付きにくいので、デプロイ前に指摘する。
  const seenGroups = new Map<string, number>();
  let previousGroup: string | undefined;
  spec.fields.forEach((field, index) => {
    const group = field.group;
    if (group !== undefined && group !== previousGroup && seenGroups.has(group)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", index, "group"],
        message:
          `group "${group}" のフィールドが離れて書かれています ` +
          `(${seenGroups.get(group)! + 1} 番目のフィールドにも同じ group があります)。` +
          " 同じ group のフィールドは続けて並べてください。",
      });
    }
    if (group !== undefined) seenGroups.set(group, index);
    previousGroup = group;
  });

  // sections では group がそのままグループフィールドのコードになるので、
  // フィールドコードと同じ規約を満たしているかをここで見る。
  if (layoutModeOf(spec.layout) === "sections") {
    const sectionCodes = new Map<string, string>();
    spec.fields.forEach((field, index) => {
      const group = field.group;
      if (group === undefined) return;

      const sectionCode = sectionCodeOf(group);
      const addIssue = (message: string): void => {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", index, "group"], message });
      };

      const existing = sectionCodes.get(sectionCode);
      if (existing !== undefined) {
        if (existing !== group) {
          addIssue(
            `group "${group}" と "${existing}" は同じグループのフィールドコード` +
              ` "${sectionCode}" になります。どちらかを変えてください。`,
          );
        }
        return;
      }
      sectionCodes.set(sectionCode, group);

      const issue = validateFieldCode(sectionCode);
      if (issue) {
        addIssue(`group から導出したフィールドコード "${sectionCode}" が不正です: ${issue.reason}`);
        return;
      }
      if (codes.has(sectionCode)) {
        addIssue(
          `group "${group}" のグループフィールドが、フィールドコード "${sectionCode}" と重複します`,
        );
      }
    });
  }

  const viewNames = new Set<string>();
  spec.views?.forEach((view, index) => {
    if (viewNames.has(view.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["views", index, "name"],
        message: `一覧名 "${view.name}" が重複しています`,
      });
    }
    viewNames.add(view.name);
  });
});

export type AppSpec = z.infer<typeof appSpecSchema>;

/** アプリ作成時に自動生成され、一覧に指定できる組み込みフィールドコード。 */
export const BUILT_IN_FIELD_CODES = new Set([
  "レコード番号",
  "作成者",
  "作成日時",
  "更新者",
  "更新日時",
  "Record_number",
  "Created_by",
  "Created_datetime",
  "Updated_by",
  "Updated_datetime",
]);

/** フィールドの実効コードを返す (未指定なら label から導出)。 */
export function resolveFieldCode(field: FieldSpec): string {
  return field.code ?? deriveFieldCode(field.label);
}

/** AppSpec に対する検証エラー。どのパスで何が起きたかを人が読める形で保持する。 */
export class AppSpecValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = "AppSpecValidationError";
  }
}

/**
 * 任意の入力を AppSpec として検証する。
 * サポート外のフィールド型は Zod のメッセージだけだと理由が伝わらないため、
 * 先に既知の「追加できない型」を検出して個別のメッセージを出す。
 */
export function parseAppSpec(input: unknown): AppSpec {
  const preIssues = detectUnsupportedFieldTypes(input);
  if (preIssues.length > 0) {
    throw new AppSpecValidationError("AppSpec の検証に失敗しました", preIssues);
  }

  const result = appSpecSchema.safeParse(input);
  if (!result.success) {
    throw new AppSpecValidationError(
      "AppSpec の検証に失敗しました",
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function detectUnsupportedFieldTypes(input: unknown): { path: string; message: string }[] {
  if (typeof input !== "object" || input === null) return [];
  const fields = (input as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];

  const issues: { path: string; message: string }[] = [];
  fields.forEach((field, index) => {
    if (typeof field !== "object" || field === null) return;
    const type = (field as { type?: unknown }).type;
    if (typeof type !== "string") return;
    const reason = UNADDABLE_FIELD_TYPES[type];
    if (reason !== undefined) {
      issues.push({ path: `fields.${index}.type`, message: `${type}: ${reason}` });
    }
  });
  return issues;
}

/** フィールドコード → group の対応。レイアウトの組み立てに渡す。 */
export function fieldGroups(spec: AppSpec): Record<string, string> {
  const groups: Record<string, string> = {};
  for (const field of spec.fields) {
    if (field.group !== undefined) {
      groups[resolveFieldCode(field)] = field.group;
    }
  }
  return groups;
}

/** フォームの並べ方。 */
export type LayoutMode = "grouped" | "stacked" | "sections";

/** layout の指定を、扱いやすい形に正規化する。 */
export function resolveLayout(spec: AppSpec): { mode: LayoutMode; maxPerRow: number } {
  const layout = spec.layout;
  if (layout === undefined) return { mode: "grouped", maxPerRow: DEFAULT_MAX_PER_ROW };
  if (typeof layout === "string") return { mode: layout, maxPerRow: DEFAULT_MAX_PER_ROW };
  return { mode: layout.mode, maxPerRow: layout.maxPerRow };
}

/** 検証の途中 (AppSpec になる前) に layout の指定だけを読む。 */
function layoutModeOf(layout: AppSpec["layout"]): LayoutMode {
  if (layout === undefined) return "grouped";
  return typeof layout === "string" ? layout : layout.mode;
}

/** レイアウトを fieldsmith が組み立てるか (stacked は既存の並びに触れない)。 */
export function appliesLayout(mode: LayoutMode): boolean {
  return mode === "grouped" || mode === "sections";
}

/** AppSpec に現れるセクション名を、書かれた順に返す。 */
export function sectionNames(spec: AppSpec): string[] {
  const names: string[] = [];
  for (const field of spec.fields) {
    if (field.group !== undefined && !names.includes(field.group)) names.push(field.group);
  }
  return names;
}

/**
 * kintone の関数。計算式に現れてもフィールド参照ではない。
 * @see https://jp.cybozu.help/k/ja/user/app_settings/form/autocalc/formula.html
 */
const CALC_FUNCTIONS = new Set([
  "SUM", "ROUND", "ROUNDDOWN", "ROUNDUP", "IF", "AND", "OR", "NOT",
  "DATE_FORMAT", "YEN", "CONTAINS",
]);

/**
 * 計算式からフィールドコードらしきものを取り出す。
 *
 * kintone の計算式は「フィールドコード・数値・演算子・関数・文字列」でできている。
 * 完全な構文解析はせず、**識別子に見えるもの**を拾って、
 * 数値・関数・文字列リテラルを除いたものをフィールド参照とみなす。
 * 取りこぼすより誤検出のほうが困るので、判断に迷うものは参照とみなさない。
 */
export function fieldReferencesIn(expression: string): string[] {
  // 文字列リテラルの中身はフィールド名ではない。
  const withoutStrings = expression.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");

  const references = new Set<string>();
  for (const token of withoutStrings.split(/[\s()+\-*/,<>=!&|]+/)) {
    if (token === "") continue;
    // 数値リテラル
    if (/^[0-9.]+$/.test(token)) continue;
    // 関数名 (直後に括弧が来るもの)
    if (CALC_FUNCTIONS.has(token.toUpperCase())) continue;
    references.add(token);
  }
  return [...references];
}
