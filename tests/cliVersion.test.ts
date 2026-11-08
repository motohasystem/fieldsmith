import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `--version` は package.json の版を出す (#12)。
 * 直書きしていた頃は 0.2.0 を入れても 0.1.0 と出て、入っている版を確かめられなかった。
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("--version", () => {
  it("package.json の版を出す", () => {
    // index.ts は読み込むと即座にコマンドを解釈するので、別プロセスで動かす。
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "--version"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(out.trim()).toBe(version);
  });
});
