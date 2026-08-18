/**
 * 実際の kintone 環境に対する手動 E2E。
 *
 * CI には載せない。実行には次が必要:
 *   - .env に kintone の設定が揃っていること
 *   - `vck login` 済みであること
 *   - 実行ユーザーに「アプリの作成」権限があること
 *
 * 検証用のアプリを 1 つ作り、運用環境への反映が SUCCESS になるところまでを確認する。
 * 作ったアプリは残るので、確認後に kintone の画面から削除すること。
 */
import { loadDotEnv, loadKintoneConfig } from "../src/config.js";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import { deployAppSpec } from "../src/kintone/deploy.js";
import { parseAppSpec } from "../src/spec/appSpec.js";

loadDotEnv();

const config = loadKintoneConfig(process.env);
const suffix = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);

const spec = parseAppSpec({
  name: `vck E2E ${suffix}`,
  description: "vck の手動 E2E で作成したアプリです。確認後に削除してください。",
  theme: "BLUE",
  fields: [
    { type: "SINGLE_LINE_TEXT", label: "件名", required: true },
    { type: "NUMBER", label: "金額", digit: true, unit: "円", unitPosition: "AFTER" },
    { type: "DROP_DOWN", label: "区分", options: ["A", "B", "C"], defaultValue: "A" },
    { type: "DATE", label: "対応日", defaultNowValue: true },
    { type: "MULTI_LINE_TEXT", label: "備考" },
  ],
  views: [{ name: "全件", type: "LIST", fields: ["件名", "金額", "区分", "対応日"], sort: "レコード番号 desc" }],
  settings: { titleFieldCode: "件名", enableComments: true },
});

console.log(`接続先: ${config.baseUrl}`);
console.log(`作成するアプリ: ${spec.name}\n`);

const kintone = createAuthenticatedKintone({ config, env: process.env });
const result = await deployAppSpec(spec, kintone, {
  onProgress: (progress) => console.log(`  ${progress.message}`),
});

console.log(`\n✓ 反映まで完了しました。`);
console.log(`  アプリ ID: ${result.appId}`);
console.log(`  URL: ${config.baseUrl}/k/${result.appId}/`);
console.log("\n以下を目視で確認してください:");
console.log("  - フィールドが 5 件、上記の順序で並んでいること");
console.log("  - 「区分」の選択肢が A / B / C で、既定値が A であること");
console.log("  - 「金額」に桁区切りと単位「円」が付いていること");
console.log("  - 一覧「全件」が存在し、レコード番号の降順になっていること");
console.log("  - アプリの説明とテーマ (青) が設定されていること");
console.log("\n確認が済んだら、このアプリを kintone の画面から削除してください。");
