#!/usr/bin/env node
/**
 * package.json の version を、Claude Code プラグインの版番号に写す。
 *
 * `claude plugin update` は版番号を比べて入れ替えるかどうかを決めるので、
 * スキルの中身を変えても版番号が古いままだと利用者の手元は更新されない。
 * `npm version` の version フックから呼ばれ、書き換えたファイルはそのまま同じコミットに入る。
 *
 *   node scripts/sync-plugin-version.mjs          書き換える
 *   node scripts/sync-plugin-version.mjs --check  ずれていたら終了コード 1（書き換えない）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const { name, version } = readJson(join(root, "package.json"));

const pluginPath = join(root, ".claude-plugin", "plugin.json");
const marketplacePath = join(root, ".claude-plugin", "marketplace.json");

const plugin = readJson(pluginPath);
const marketplace = readJson(marketplacePath);
const entry = marketplace.plugins?.find((p) => p.name === plugin.name);
if (!entry) {
  console.error(`marketplace.json に ${plugin.name} の項目がありません`);
  process.exit(1);
}

// JSON を書き出し直すと整形が崩れるので、version の値だけを文字列として置き換える
const targets = [
  { path: pluginPath, holder: plugin },
  { path: marketplacePath, holder: entry },
];

const stale = targets.filter((t) => t.holder.version !== version);
if (stale.length === 0) {
  console.log(`プラグインの版番号は ${name}@${version} と揃っています`);
  process.exit(0);
}

for (const t of stale) {
  const rel = relative(root, t.path);
  if (check) {
    console.error(`${rel}: ${t.holder.version} → ${version} に揃えてください（npm run sync-plugin-version）`);
    continue;
  }
  console.log(`${rel}: ${t.holder.version} → ${version}`);
  const text = readFileSync(t.path, "utf8");
  const line = new RegExp(`("version"\\s*:\\s*)"${t.holder.version.replaceAll(".", "\\.")}"`);
  if (!line.test(text)) {
    console.error(`${rel}: version の行が見つかりません`);
    process.exit(1);
  }
  writeFileSync(t.path, text.replace(line, `$1"${version}"`));
}
if (check) process.exit(1);
