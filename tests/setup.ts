// Vitest のグローバルセットアップ。
// 実環境の資格情報がテストに漏れ込まないよう、kintone / Anthropic の環境変数を消しておく。
for (const key of Object.keys(process.env)) {
  if (key.startsWith("KINTONE_") || key.startsWith("ANTHROPIC_") || key === "FIELDSMITH_CONFIG_DIR") {
    delete process.env[key];
  }
}
