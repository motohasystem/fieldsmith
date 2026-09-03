import { zodToJsonSchema } from "zod-to-json-schema";
import { APP_THEMES, appSpecSchema, BUILT_IN_FIELD_CODES } from "../spec/appSpec.js";
import { describeFieldTypes, OPTION_FIELD_TYPES, UNADDABLE_FIELD_TYPES } from "../spec/fieldSpec.js";
import { DEFAULT_MAX_PER_ROW } from "../spec/layout.js";

/**
 * AppSpec の書き方を機械にも人にも伝えるための出力。
 *
 * AI エージェントが AppSpec を書くとき、型や `options` の書き方を推測させると失敗する。
 * すべて Zod の定義から導出しているので、実装とずれない。
 */

/** 完全な JSON Schema。`--json` 用。 */
export function appSpecJsonSchema(): unknown {
  return zodToJsonSchema(appSpecSchema, { name: "AppSpec", $refStrategy: "none" });
}

/** 人にもエージェントにも読める、簡潔な一覧。 */
export function appSpecReference(): string {
  const lines: string[] = [];

  lines.push("# AppSpec の書き方");
  lines.push("");
  lines.push("kintone アプリ 1 つを表す JSON。`fieldsmith deploy <file>` に渡す。");
  lines.push("完全な JSON Schema は `fieldsmith schema --json` で出力できる。");
  lines.push("");

  lines.push("## トップレベル");
  lines.push("");
  lines.push("| キー | 必須 | 説明 |");
  lines.push("|---|---|---|");
  lines.push("| `name` | ✓ | アプリ名。64 文字以内 |");
  lines.push("| `fields` | ✓ | フィールドの配列。並び順がフォームの順序になる |");
  lines.push("| `description` | | アプリの説明。10,000 文字以内 |");
  lines.push(`| \`theme\` | | ${APP_THEMES.join(" / ")} |`);
  lines.push("| `icon` | | アプリアイコンにする絵文字 1 文字、または頭文字 |");
  lines.push("| `iconBackground` | | アイコンの背景色 `#rrggbb`。省略時はアプリ名から決まる |");
  lines.push("| `space` | | 作成先のスペース ID |");
  lines.push("| `thread` | | スペース内のスレッド ID |");
  lines.push("| `guestSpaceId` | | ゲストスペース ID |");
  lines.push(
    `| \`layout\` | | \`"grouped"\` (既定) / \`"sections"\` / \`"stacked"\` /` +
      ` \`{ "mode": "grouped", "maxPerRow": ${DEFAULT_MAX_PER_ROW} }\` |`,
  );
  lines.push("| `views` | | 一覧の配列 |");
  lines.push("| `settings` | | 一般設定 |");
  lines.push("");

  lines.push("## フィールド");
  lines.push("");
  lines.push("すべての型に共通の任意キー: `code` `required` `unique` `noLabel` `group`");
  lines.push("");
  lines.push("- `code` を省略すると `label` から自動で導出される");
  lines.push("- `group` は意味のまとまりの名前。同じ `group` のフィールドは横に並ぶので、");
  lines.push("  **続けて並べること**（離れていると検証で弾かれる）");
  lines.push("");
  lines.push("### layout の 3 つの指定");
  lines.push("");
  lines.push("| 指定 | 動き |");
  lines.push("|---|---|");
  lines.push("| `grouped` (既定) | 同じ `group` のフィールドを横に並べる。kintone 上にまとまりは現れない |");
  lines.push("| `sections` | 同じ `group` のフィールドを **kintone のグループフィールド**に入れる |");
  lines.push("| `stacked` | 並びに手を触れない。既存アプリの更新で、いまの配置を守りたいときに使う |");
  lines.push("");
  lines.push("`sections` では `group` の名前がグループのフィールドコードになるので、");
  lines.push("フィールドコードと重ならない名前にする（重なると検証で弾かれる）。");
  lines.push("");
  lines.push("| 型 | 固有のキー |");
  lines.push("|---|---|");

  const common = new Set(["label", "code", "required", "unique", "noLabel", "group"]);
  for (const entry of describeFieldTypes()) {
    const own = entry.keys
      .filter((key) => !common.has(key.name))
      .map((key) => (key.required ? `**${key.name}** (必須)` : key.name));
    lines.push(`| \`${entry.type}\` | ${own.length > 0 ? own.join(", ") : "-"} |`);
  }
  lines.push("");
  lines.push(
    `\`options\` は文字列の配列で書く（例: \`["高", "中", "低"]\`）。` +
      `必要なのは ${OPTION_FIELD_TYPES.map((t) => `\`${t}\``).join(" ")}。`,
  );
  lines.push("");
  lines.push(
    "`CALC` の `expression` には、**`fields` で定義したフィールドコード**を使う。" +
      " 存在しないフィールドを参照していると検証で弾かれる。",
  );
  lines.push("");

  lines.push("## 指定できない型");
  lines.push("");
  for (const [type, reason] of Object.entries(UNADDABLE_FIELD_TYPES)) {
    lines.push(`- \`${type}\`: ${reason}`);
  }
  lines.push("");
  lines.push(
    "レコード番号・作成者・作成日時・更新者・更新日時はアプリ作成時に自動で用意されるので、",
  );
  lines.push("`fields` に書かない。一覧の `fields` には指定できる。");
  lines.push("");

  lines.push("## 一覧 (views)");
  lines.push("");
  lines.push("| キー | 必須 | 説明 |");
  lines.push("|---|---|---|");
  lines.push("| `name` | ✓ | 一覧の名前。64 文字以内 |");
  lines.push("| `type` | | `LIST` (既定) / `CALENDAR` |");
  lines.push("| `fields` | | 表示するフィールドコードの配列 |");
  lines.push("| `date` | | CALENDAR で日付として使うフィールドコード |");
  lines.push("| `filterCond` | | 絞り込み条件（kintone のクエリ形式）|");
  lines.push("| `sort` | | 並び順（例: `更新日時 desc`）|");
  lines.push("");
  lines.push("`fields` `date` `title` に書けるのは、**`fields` で定義したフィールドコード**と、");
  lines.push("次の組み込みフィールドだけ。");
  lines.push("");
  lines.push(
    [...BUILT_IN_FIELD_CODES].map((code) => `\`${code}\``).join(" "),
  );
  lines.push("");
  lines.push(
    "**フィールドを `fields` から外したら、一覧の `fields` からも外すこと。**" +
      " 参照が残っていると検証で弾かれる。",
  );
  lines.push("");

  lines.push("## 一般設定 (settings)");
  lines.push("");
  lines.push(
    "`titleFieldCode` `enableComments` `enableThumbnails` `enableBulkDeletion` " +
      "`enableDuplicateRecord` `enableInlineRecordEditing` `firstMonthOfFiscalYear`",
  );
  lines.push("");

  lines.push("## 検証");
  lines.push("");
  lines.push("```bash");
  lines.push("fieldsmith deploy <file> --dry-run --json   # kintone にも Claude にも接続せずに検証できる");
  lines.push("```");

  return lines.join("\n");
}

/** そのまま `fieldsmith deploy` に渡せる実例。 */
export function appSpecExample(): unknown {
  return {
    name: "案件管理",
    description: "営業案件の進捗を管理します。",
    theme: "BLUE",
    icon: "💼",
    layout: { mode: "grouped", maxPerRow: 3 },
    fields: [
      { type: "SINGLE_LINE_TEXT", label: "案件名", required: true, group: "案件" },
      { type: "SINGLE_LINE_TEXT", label: "顧客名", required: true, group: "案件" },
      {
        type: "NUMBER",
        label: "金額",
        unit: "円",
        unitPosition: "AFTER",
        digit: true,
        group: "金額",
      },
      {
        type: "DROP_DOWN",
        label: "受注確度",
        options: ["高", "中", "低"],
        defaultValue: "中",
        group: "見込み",
      },
      { type: "DATE", label: "受注予定日", group: "見込み" },
      { type: "USER_SELECT", label: "担当者", group: "担当" },
      { type: "MULTI_LINE_TEXT", label: "備考" },
    ],
    views: [
      {
        name: "全件",
        type: "LIST",
        fields: ["案件名", "顧客名", "金額", "受注確度", "受注予定日"],
        sort: "受注予定日 asc",
      },
      {
        name: "確度の高い案件",
        type: "LIST",
        fields: ["案件名", "顧客名", "金額"],
        filterCond: '受注確度 in ("高")',
      },
    ],
    settings: { titleFieldCode: "案件名", enableComments: true },
  };
}
