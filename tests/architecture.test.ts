import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuthenticatedKintone } from "../src/kintone/client.js";
import { deployAppSpec } from "../src/kintone/deploy.js";
import { fieldGroups, parseAppSpec, resolveFieldCode, resolveLayout } from "../src/spec/appSpec.js";
import { groupIntoRows } from "../src/spec/layout.js";
import { renderIcon } from "../src/icon/render.js";
import { toKintonePayloads } from "../src/spec/toKintone.js";
import { REQUIRED_SCOPE } from "../src/kintone/oauth.js";
import { saveToken } from "../src/kintone/tokenStore.js";
import { BASE_URL, noSleep, setupKintoneMock } from "./kintoneMock.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * 「plan は LLM を使い、deploy は使わない」という境界を守るためのテスト。
 *
 * この分離があるおかげで、デプロイ経路はモックだけで完全に検証でき、
 * 手書きの AppSpec を LLM 抜きでデプロイできる。
 * 境界は口約束では保てないので、ここで固定する。
 */

const SRC = join(import.meta.dirname, "..", "src");

/** ディレクトリ配下の .ts を再帰的に集める。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("plan と deploy の境界", () => {
  const deploySide = ["kintone", "spec", "icon"];

  it.each(deploySide)("src/%s は LLM に依存しない", (dir) => {
    const offenders = sourceFiles(join(SRC, dir)).filter((path) => {
      const source = readFileSync(path, "utf-8");
      return /from\s+["'][^"']*\/llm\//.test(source) || /@anthropic-ai/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("LLM 層はデプロイを呼ばない (生成とデプロイは CLI が繋ぐ)", () => {
    const offenders = sourceFiles(join(SRC, "llm")).filter((path) =>
      /from\s+["'][^"']*\/kintone\//.test(readFileSync(path, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });

  it("デプロイ経路に乱数が無い", () => {
    // oauth.ts は `vck login` の経路 (認可の state 生成に乱数を使う)。
    // deploy が通るのは deploy.ts / client.ts / tokenStore.ts と spec / icon 配下。
    const deployPath = [
      join(SRC, "kintone", "deploy.ts"),
      join(SRC, "kintone", "client.ts"),
      join(SRC, "kintone", "tokenStore.ts"),
      ...sourceFiles(join(SRC, "spec")),
      ...sourceFiles(join(SRC, "icon")),
    ];

    const offenders = deployPath.filter((path) =>
      /Math\.random|randomBytes|randomUUID/.test(readFileSync(path, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("同じ AppSpec からは同じものが出る", () => {
  const spec = parseAppSpec({
    name: "書籍管理",
    description: "蔵書を管理します",
    theme: "BLUE",
    icon: "📚",
    fields: [
      { type: "SINGLE_LINE_TEXT", label: "書名", required: true, group: "書籍" },
      { type: "SINGLE_LINE_TEXT", label: "著者", group: "書籍" },
      { type: "SINGLE_LINE_TEXT", label: "出版社", group: "書誌情報" },
      { type: "NUMBER", label: "出版年", group: "書誌情報" },
      { type: "MULTI_LINE_TEXT", label: "メモ" },
    ],
    views: [{ name: "全件", type: "LIST", fields: ["書名", "著者"] }],
    settings: { titleFieldCode: "書名" },
  });

  it("kintone に送るペイロードが一致する", () => {
    expect(toKintonePayloads(spec)).toEqual(toKintonePayloads(spec));
  });

  it("フォームの並びが一致する", () => {
    const layout = resolveLayout(spec);
    const rows = () =>
      groupIntoRows(
        spec.fields.map((field) => ({ type: field.type, code: resolveFieldCode(field) })),
        { maxPerRow: layout.maxPerRow, groups: fieldGroups(spec) },
      );
    expect(rows()).toEqual(rows());
  });

  it("アイコン画像がバイト単位で一致する", () => {
    const render = () => renderIcon({ glyph: spec.icon!, background: "#2563eb" }).png;
    expect(render().equals(render())).toBe(true);
  });

  it("同じ AppSpec を 2 回デプロイすると、同じ API 呼び出しになる", async () => {
    const run = async () => {
      const { server, mock } = setupKintoneMock({
        layout: spec.fields.map((field) => ({
          type: "ROW",
          fields: [{ type: field.type, code: resolveFieldCode(field) }],
        })),
      });
      server.listen({ onUnhandledRequest: "error" });

      const dir = mkdtempSync(join(tmpdir(), "vck-arch-"));
      const env: NodeJS.ProcessEnv = { VCK_CONFIG_DIR: dir };
      saveToken(
        BASE_URL,
        { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scope: REQUIRED_SCOPE },
        env,
      );

      await deployAppSpec(spec, createAuthenticatedKintone({ config, env }), {
        polling: { initialDelayMs: 0, maxDelayMs: 0, sleep: noSleep },
      });
      server.close();
      rmSync(dir, { recursive: true, force: true });

      // fileKey はサーバーが決めるので、比較からは外す。
      return mock.calls.map((call) => ({ path: call.path, body: call.body }));
    };

    expect(await run()).toEqual(await run());
  });
});

const config = {
  baseUrl: BASE_URL,
  clientId: "c",
  clientSecret: "s",
  redirectUri: "https://app.example.com/cb",
  authorizationEndpoint: `${BASE_URL}/oauth2/authorization`,
  tokenEndpoint: `${BASE_URL}/oauth2/token`,
};
