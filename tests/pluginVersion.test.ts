import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `claude plugin update` は版番号でしか入れ替えを判断しない。
 * package.json だけ上げてプラグイン側を忘れると、利用者のスキルが古いまま残る。
 */
const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("プラグインの版番号", () => {
  const { version } = readJson("package.json");
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");

  it("plugin.json は package.json と同じ版番号", () => {
    expect(plugin.version).toBe(version);
  });

  it("marketplace.json の項目も同じ版番号", () => {
    const entry = marketplace.plugins.find((p: { name: string }) => p.name === plugin.name);
    expect(entry?.version).toBe(version);
  });
});
