#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { KintoneRestAPIError } from "@kintone/rest-api-client";
import { Command } from "commander";
import { ConfigError, loadDotEnv, loadKintoneConfig, type KintoneConfig } from "../config.js";
import { createAuthenticatedKintone, KintoneRequestError } from "../kintone/client.js";
import {
  DeployError,
  deployAppSpec,
  pullApp,
  UnsupportedUpdateError,
  updateApp,
  type DeployProgress,
} from "../kintone/deploy.js";
import {
  buildAuthorizationRequest,
  exchangeAuthorizationCode,
  extractAuthorizationCode,
  OAuthError,
  REQUIRED_SCOPE,
} from "../kintone/oauth.js";
import { clearToken, loadToken, saveToken } from "../kintone/tokenStore.js";
import {
  AppSpecGenerationError,
  DEFAULT_TIMEOUT_MS,
  generateAppSpec,
  type GenerationEvent,
} from "../llm/generate.js";
import {
  AppSpecValidationError,
  fieldGroups,
  parseAppSpec,
  resolveFieldCode,
  resolveLayout,
  type AppSpec,
} from "../spec/appSpec.js";
import { describeDiff, diffAppSpec, isEmptyDiff } from "../spec/diff.js";
import { describeRows, groupIntoRows } from "../spec/layout.js";
import { toKintonePayloads } from "../spec/toKintone.js";
import { backgroundFor, renderIcon } from "../icon/render.js";
import { EXIT_HINT } from "./exit.js";
import { emitFailure, emitSuccess, isJsonMode, say, setJsonMode } from "./output.js";
import { appSpecExample, appSpecJsonSchema, appSpecReference } from "./schema.js";
import { startStatusLine, tailLine } from "./progress.js";
import { LARGE_PROMPT_CHARS, PromptInputError, resolvePrompt } from "./promptInput.js";

const program = new Command();

program
  .name("vck")
  .description(
    "AppSpec (JSON) から kintone アプリを何度でも作る CLI。AppSpec は要件の文章からも作れる。",
  )
  .version("0.1.0")
  .option("-v, --verbose", "何をしているかを詳しく表示する (思考の要約、API 呼び出し、revision の遷移)")
  .option("--json", "結果を JSON で stdout に出す。人間向けの表示は stderr に回る")
  .hook("preAction", () => setJsonMode(program.opts()["json"] === true));

/** --verbose はどのサブコマンドでも同じ意味なので、トップレベルの指定を見る。 */
function isVerbose(): boolean {
  return program.opts()["verbose"] === true;
}

/** --verbose のときだけ出す補足行。進捗表示と混ざらないよう stderr に出す。 */
function trace(message: string): void {
  if (isVerbose()) {
    process.stderr.write(`  ${message}\n`);
  }
}

/**
 * 生成中の進捗を 1 行のステータスとして見せる。
 * --verbose なら思考の要約もそこに流し、いま何を考えているかまで見えるようにする。
 */
async function generateWithProgress(prompt: string, model: string | undefined) {
  // まだサーバーから何も返っていないことが分かる文言にする。
  // 「接続しています」のままカウントが進むのは応答待ちを意味する。
  const status = startStatusLine("リクエストを送信しました (サーバーの応答を待っています)");
  let thinking = "";
  let connected = false;
  let wroteFirstChunk = false;

  // 応答が来ないまま長引いた場合に、待っているだけだと分かるようにする。
  // TTY ではスピナーが経過秒を出し続けるので、ここは間隔を空けて十分。
  const stallTimer = setInterval(() => {
    if (!connected) {
      status.update(
        `サーバーの応答を待っています (${status.elapsedSeconds()} 秒経過 / 上限 ${Math.round(DEFAULT_TIMEOUT_MS / 1000)} 秒)`,
      );
    }
  }, 15_000);
  stallTimer.unref?.();

  const onEvent = (event: GenerationEvent): void => {
    switch (event.type) {
      case "connected":
        connected = true;
        clearInterval(stallTimer);
        trace(`モデル: ${event.model}`);
        trace(`リクエスト ID: ${event.requestId ?? "(取得できず)"}`);
        // 節目は履歴に残す (非 TTY では update が表示されないため)。
        status.log("  設計を考えています");
        status.update("設計を考えています");
        break;
      case "schemaFallback":
        status.log("  構造化出力が使えないため、JSON を直接生成する方式に切り替えます");
        trace(`  理由: ${event.reason}`);
        break;
      case "streamEvent":
        // 生イベントは切り分け用。既定では出さない。
        trace(`イベント: ${event.name} (${status.elapsedSeconds()} 秒)`);
        break;
      case "thinking":
        thinking += event.delta;
        status.update(
          isVerbose() ? `考え中: ${tailLine(thinking, 60)}` : "設計を考えています",
        );
        break;
      case "writing":
        if (wroteFirstChunk === false) {
          wroteFirstChunk = true;
          status.log("  設計を書き出しています");
        }
        status.update(`設計を書き出しています (${event.totalChars} 文字)`);
        break;
      case "done":
        status.done(
          `✓ 設計を生成しました (${status.elapsedSeconds()} 秒, 入力 ${event.inputTokens} / 出力 ${event.outputTokens} トークン)`,
        );
        break;
    }
  };

  try {
    return await generateAppSpec(prompt, {
      onEvent,
      ...(model === undefined ? {} : { model }),
    });
  } finally {
    clearInterval(stallTimer);
    // 失敗した場合もステータス行を残さない。
    status.done();
  }
}

program
  .command("schema")
  .description("AppSpec の書き方を出力する (AI エージェントに読ませる用)")
  .option("--json", "完全な JSON Schema を出力する")
  .option("--example", "そのまま deploy できる実例を出力する")
  .action((options: { json?: boolean; example?: boolean }) => {
    if (options.example === true) {
      process.stdout.write(`${JSON.stringify(appSpecExample(), null, 2)}\n`);
      return;
    }
    if (options.json === true || isJsonMode()) {
      process.stdout.write(`${JSON.stringify(appSpecJsonSchema(), null, 2)}\n`);
      return;
    }
    process.stdout.write(`${appSpecReference()}\n`);
  });

program
  .command("deploy")
  .description("AppSpec を kintone にデプロイする。同じ AppSpec から何個でも作れる")
  .argument("<spec>", "AppSpec の JSON ファイル")
  .option("--dry-run", "kintone に送信せず、送信予定の内容を表示する")
  .option("--space <id>", "アプリを作成するスペース ID (AppSpec の space より優先)")
  .option("--thread <id>", "スペース内のスレッド ID")
  .option("--guest-space <id>", "ゲストスペース ID")
  .option("--revert-on-failure", "途中で失敗した場合に動作テスト環境の変更を破棄する")
  .action(async (specPath: string, options: DeployCommandOptions) => {
    await run("deploy", async () => {
      const spec = readSpecFile(specPath);
      await deployWithOptions(spec, options);
    });
  });

program
  .command("pull")
  .description("既存アプリの設定を AppSpec として取り出す (kintone を変更しない)")
  .argument("<appId>", "アプリ ID")
  .option("-o, --out <path>", "保存先。省略時は標準出力")
  .action(async (appId: string, options: { out?: string }) => {
    await run("pull", async () => {
      const config = config_();
      trace(`接続先: ${config.baseUrl}`);

      const kintone = createAuthenticatedKintone({ config, env: process.env });
      const pulled = await pullApp(appId, kintone, {
        onProgress: (progress) => {
          say(`  ${progress.message}`);
          if (progress.detail !== undefined && isVerbose()) trace(`    ${progress.detail}`);
        },
      });

      // 取得した spec が本当にデプロイできる形かを、ここで確かめる。
      // 通らないものを渡すと、使う側が原因を追うことになる。
      const spec = parseAppSpec(pulled.spec);
      const json = `${JSON.stringify(spec, null, 2)}\n`;

      if (options.out === undefined) {
        if (!isJsonMode()) process.stdout.write(json);
      } else {
        writeFileSync(options.out, json, "utf-8");
        say(`✓ ${options.out} に保存しました。`);
      }

      if (pulled.warnings.length > 0) {
        say("");
        say("次の設定は AppSpec で表現できないため含まれていません:");
        for (const warning of pulled.warnings) say(`  - ${warning}`);
      }

      emitSuccess({
        command: "pull",
        app: { id: pulled.appId, name: pulled.appName },
        spec,
        warnings: pulled.warnings,
        ...(options.out === undefined ? {} : { out: options.out }),
      });
    });
  });

program
  .command("diff")
  .description("既存アプリと AppSpec の差分を表示する (kintone を変更しない)")
  .argument("<appId>", "アプリ ID")
  .argument("<spec>", "目標とする AppSpec の JSON ファイル")
  .action(async (appId: string, specPath: string) => {
    await run("diff", async () => {
      const desired = readSpecFile(specPath);
      const config = config_();
      const kintone = createAuthenticatedKintone({ config, env: process.env });

      const pulled = await pullApp(appId, kintone);
      const current = parseAppSpec(pulled.spec);
      const diff = diffAppSpec(current, desired);

      if (isEmptyDiff(diff)) {
        say(`アプリ ${appId}「${pulled.appName}」と ${specPath} に差分はありません。`);
      } else {
        say(`アプリ ${appId}「${pulled.appName}」と ${specPath} の差分:`);
        say("");
        for (const line of describeDiff(diff)) say(line);

        if (diff.retyped.length > 0) {
          say("");
          say("! kintone は作成後のフィールド型を変更できません。");
          say("  型を変えるには、別のフィールドコードで新しく作り、");
          say("  古いフィールドを削除候補に送ることになります (データは移りません)。");
        }
        if (diff.orphaned.length > 0) {
          say("");
          say("- 削除候補のフィールドは削除されず、畳んだグループに移されます (データは残ります)。");
        }
      }

      emitSuccess({
        command: "diff",
        app: { id: appId, name: pulled.appName },
        hasChanges: !isEmptyDiff(diff),
        diff,
        warnings: pulled.warnings,
      });
    });
  });

program
  .command("update")
  .description("既存アプリを AppSpec の内容に近づける (既定では運用環境へ反映しない)")
  .argument("<appId>", "アプリ ID")
  .argument("<spec>", "目標とする AppSpec の JSON ファイル")
  .option("--deploy", "運用環境まで反映する")
  .action(async (appId: string, specPath: string, options: { deploy?: boolean }) => {
    await run("update", async () => {
      const desired = readSpecFile(specPath);
      const config = config_();
      const kintone = createAuthenticatedKintone({ config, env: process.env });

      const status = startStatusLine("差分を調べています");
      let result;
      try {
        result = await updateApp(appId, desired, kintone, {
          ...(options.deploy === true ? { deploy: true } : {}),
          onProgress: (progress) => {
            // 「動作テスト環境まで反映しました」は後段でまとめて案内するので、
            // ここでは履歴に残さない (同じ文言が二度出てしまう)。
            if (progress.step !== "deploy" || options.deploy === true) {
              status.log(`  ${progress.message}`);
              if (progress.detail !== undefined && isVerbose()) status.log(`    ${progress.detail}`);
            }
            status.update(progress.message);
          },
        });
      } finally {
        status.done();
      }

      if (isEmptyDiff(result.diff) || result.revision === "-1") {
        say(`アプリ ${appId}「${result.appName}」に適用する変更はありません。`);
        if (result.diff.orphaned.length > 0) {
          say(
            `  ${result.diff.orphaned.length} 件のフィールドは、すでに削除候補グループに入っています。`,
          );
        }
      } else {
        say("");
        say("適用した内容:");
        for (const line of describeDiff(result.diff)) say(line);

        if (result.pendingOrphans.length > 0) {
          say("");
          say(`- ${result.pendingOrphans.length} 件のフィールドを「削除候補」グループに移しました。`);
          say("  削除はしていないので、データは残っています。");
        }
        if (!result.deployed) {
          say("");
          say("動作テスト環境まで反映しました。運用環境にはまだ反映していません。");
          say(`  ${config.baseUrl}/k/${appId}/ で「変更を確認」してください。`);
          say(`  問題なければ --deploy を付けて再実行します。`);
        } else {
          say("");
          say(`✓ 運用環境へ反映しました。`);
          say(`  ${config.baseUrl}/k/${appId}/`);
        }
      }

      emitSuccess({
        command: "update",
        app: { id: appId, name: result.appName, url: `${config.baseUrl}/k/${appId}/` },
        hasChanges: result.revision !== "-1",
        deployed: result.deployed,
        movedToOrphanGroup: result.pendingOrphans,
        revision: result.revision,
        diff: result.diff,
        warnings: result.warnings,
      });
    });
  });

program
  .command("status")
  .description("アプリの運用環境への反映状況を確認する")
  .argument("<appId>", "アプリ ID")
  .action(async (appId: string) => {
    await run("status", async () => {
      const config = config_();
      const kintone = createAuthenticatedKintone({ config, env: process.env });
      const { apps } = await kintone.call((client) => client.app.getDeployStatus({ apps: [appId] }));
      for (const app of apps) {
        say(`アプリ ${app.app}: ${app.status}`);
      }
      emitSuccess({ command: "status", apps });
    });
  });

program
  .command("login")
  .description("kintone の OAuth 認可を行い、トークンを保存する (deploy に必要)")
  .action(async () => {
    await run("login", async () => {
      const config = config_();
      const { url, state } = buildAuthorizationRequest(config);

      say("次の URL をブラウザで開き、アクセスを許可してください:\n");
      say(`  ${url}\n`);
      say(`要求するスコープ: ${REQUIRED_SCOPE}`);
      say("許可すると、登録済みのリダイレクト先へ転送されます。");
      say("転送先のアドレスバーの URL を、そのままここに貼り付けてください。\n");

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const redirected = await rl.question("リダイレクト先の URL: ");
      rl.close();

      const code = extractAuthorizationCode(redirected, state);
      const token = await exchangeAuthorizationCode(config, code);
      saveToken(config.baseUrl, token, process.env);

      say(`\n✓ ${config.baseUrl} の認証情報を保存しました。`);
      say("  アクセストークンは 1 時間で失効しますが、以降は自動で更新されます。");
      emitSuccess({ command: "login", baseUrl: config.baseUrl });
    });
  });

program
  .command("logout")
  .description("保存済みのトークンを破棄する")
  .action(async () => {
    await run("logout", async () => {
      const config = config_();
      const cleared = clearToken(config.baseUrl, process.env);
      say(
        cleared
          ? `✓ ${config.baseUrl} の認証情報を破棄しました。`
          : `${config.baseUrl} の認証情報は保存されていません。`,
      );
      emitSuccess({ command: "logout", baseUrl: config.baseUrl, cleared });
    });
  });

program
  .command("plan")
  .description("要件から AppSpec を生成する。kintone には接続しない (要 Claude API)")
  .argument("[prompt]", "作りたいアプリの説明。--prompt-file を使う場合は省略する")
  .option("-f, --prompt-file <path>", "説明を書いたファイル。`-` で標準入力から読む")
  .option("-o, --out <path>", "生成した AppSpec の保存先。省略時は標準出力")
  .option("--model <model>", "使用するモデル")
  .action(async (prompt: string | undefined, options: { out?: string; model?: string; promptFile?: string }) => {
    await run("plan", async () => {
      const input = readPrompt(prompt, options.promptFile);
      const spec = await generateWithProgress(input.text, options.model);
      const json = `${JSON.stringify(spec, null, 2)}\n`;

      if (options.out === undefined) {
        // --json のときは emitSuccess が spec を含むので二重に出さない。
        if (!isJsonMode()) process.stdout.write(json);
      } else {
        writeFileSync(options.out, json, "utf-8");
        say(`✓ ${options.out} に保存しました。`);
        printSpecSummary(spec);
      }
      emitSuccess({
        command: "plan",
        spec,
        ...(options.out === undefined ? {} : { out: options.out }),
      });
    });
  });

program
  .command("create")
  .description("要件から AppSpec を生成し、確認のうえデプロイする (要 Claude API)")
  .argument("[prompt]", "作りたいアプリの説明。--prompt-file を使う場合は省略する")
  .option("-f, --prompt-file <path>", "説明を書いたファイル。`-` で標準入力から読む")
  .option("-y, --yes", "確認せずにデプロイする")
  .option("--dry-run", "kintone に送信せず、送信予定の内容を表示する")
  .option("--space <id>", "アプリを作成するスペース ID (AppSpec の space より優先)")
  .option("--thread <id>", "スペース内のスレッド ID")
  .option("--guest-space <id>", "ゲストスペース ID")
  .option("--revert-on-failure", "途中で失敗した場合に動作テスト環境の変更を破棄する")
  .option("--model <model>", "使用するモデル")
  .option("-o, --out <path>", "生成した AppSpec の保存先")
  .action(
    async (
      prompt: string | undefined,
      options: DeployCommandOptions & {
        yes?: boolean;
        model?: string;
        out?: string;
        promptFile?: string;
      },
    ) => {
    await run("create", async () => {
      const input = readPrompt(prompt, options.promptFile);
      const spec = await generateWithProgress(input.text, options.model);

      printSpecSummary(spec);
      if (options.out !== undefined) {
        writeFileSync(options.out, `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
        say(`\nAppSpec を ${options.out} に保存しました。`);
      }

      if (options.dryRun !== true && options.yes !== true && !(await confirm("\nこの内容でデプロイしますか?"))) {
        say("中止しました。");
        emitSuccess({ command: "create", deployed: false, spec });
        return;
      }
      await deployWithOptions(spec, options);
    });
  });

interface DeployCommandOptions {
  readonly dryRun?: boolean;
  readonly space?: string;
  readonly thread?: string;
  readonly guestSpace?: string;
  readonly revertOnFailure?: boolean;
}

async function deployWithOptions(spec: AppSpec, options: DeployCommandOptions): Promise<void> {
  if (options.dryRun === true) {
    const payloads = toKintonePayloads(spec);
    say("--dry-run のため送信しません。kintone に送る内容:\n");
    if (spec.icon !== undefined) {
      // アイコンは fileKey がデプロイ時にしか決まらないので、ここでは生成結果だけ示す。
      const icon = renderIcon({
        glyph: spec.icon,
        background: spec.iconBackground ?? backgroundFor(spec.name),
      });
      say(
        `アイコン: ${spec.icon} を ${icon.mode === "emoji" ? "絵文字" : "文字"}として描画 ` +
          `(${Math.round(icon.png.length / 1024)}KB) → アップロード後に icon.file.fileKey として設定\n`,
      );
    }
    say(JSON.stringify(payloads, null, 2));
    emitSuccess({ command: "deploy", dryRun: true, appName: spec.name, payloads });
    return;
  }

  const config = config_();
  trace(`接続先: ${config.baseUrl}`);

  // CLI の指定を AppSpec より優先する。
  const spaceId = options.space ?? spec.space;
  const threadId = options.thread ?? spec.thread;
  const guestSpaceId = options.guestSpace ?? spec.guestSpaceId;

  if (spaceId !== undefined) {
    trace(`スペース: ${spaceId}${threadId === undefined ? "" : ` / スレッド ${threadId}`}`);
  }

  const kintone = createAuthenticatedKintone({
    config,
    env: process.env,
    ...(guestSpaceId === undefined ? {} : { guestSpaceId }),
  });

  say(`「${spec.name}」をデプロイします (フィールド ${spec.fields.length} 件)`);

  // どのステップで待っているかと経過秒が常に動くようにする。
  // 各リクエストには上限時間があるので、無限に止まったままにはならない。
  const status = startStatusLine("開始しています");

  let result;
  try {
    result = await deployAppSpec(spec, kintone, {
      ...(spaceId === undefined ? {} : { spaceId }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(guestSpaceId === undefined ? {} : { guestSpaceId }),
      ...(options.revertOnFailure === true ? { revertOnFailure: true } : {}),
      onProgress: (progress: DeployProgress) => {
        status.log(`  ${progress.message}`);
        if (progress.detail !== undefined && isVerbose()) {
          status.log(`    ${progress.detail}`);
        }
        status.update(progress.message);
      },
    });
  } finally {
    status.done();
  }

  const url = `${config.baseUrl}/k/${result.appId}/`;
  say(`\n✓ デプロイが完了しました。`);
  say(`  アプリ ID: ${result.appId}`);
  say(`  URL: ${url}`);

  emitSuccess({
    command: "deploy",
    app: { id: result.appId, url, name: spec.name },
    revision: result.revision,
    fieldCount: spec.fields.length,
  });
}

function readSpecFile(path: string): AppSpec {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    throw new CliError(`AppSpec のファイルを読み込めませんでした: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CliError(`${path} を JSON として解釈できませんでした: ${(error as Error).message}`);
  }
  return parseAppSpec(parsed);
}

function printSpecSummary(spec: AppSpec): void {
  say(`\nアプリ名: ${spec.name}`);
  if (spec.icon !== undefined) {
    say(`アイコン: ${spec.icon} (背景 ${spec.iconBackground ?? backgroundFor(spec.name)})`);
  }
  if (spec.space !== undefined) {
    say(`スペース: ${spec.space}`);
  }
  if (spec.description !== undefined) {
    say(`説明: ${spec.description}`);
  }
  say(`フィールド (${spec.fields.length} 件):`);
  for (const field of spec.fields) {
    const marks: string[] = [field.type];
    if (field.required === true) marks.push("必須");
    if ("options" in field) marks.push(field.options.join(" / "));
    say(`  - ${field.label} [${marks.join(", ")}]`);
  }
  if (spec.views !== undefined) {
    say(`一覧 (${spec.views.length} 件): ${spec.views.map((view) => view.name).join(", ")}`);
  }

  const layout = resolveLayout(spec);
  if (layout.mode === "grouped") {
    // 実際の並べ替えは kintone から取得したレイアウトに対して行うが、
    // 結果は同じになるので、ここでは AppSpec から予想を見せる。
    const rows = groupIntoRows(
      spec.fields.map((field) => ({ type: field.type, code: resolveFieldCode(field) })),
      { maxPerRow: layout.maxPerRow, groups: fieldGroups(spec) },
    );
    say(`フォームの並び (最大 ${layout.maxPerRow} 列 → ${rows.length} 行):`);
    for (const line of describeRows(rows)) {
      say(`  ${line}`);
    }
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N]: `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * プロンプトを引数・ファイル・標準入力のいずれかから読む。
 * どこから読んだかと分量は必ず知らせる (意図しない入力で生成が走るのを防ぐため)。
 */
function readPrompt(argument: string | undefined, filePath: string | undefined) {
  const input = resolvePrompt({ argument, filePath });

  if (filePath !== undefined) {
    say(`要件を ${input.source} から読み込みました (${input.text.length} 文字)`);
  }
  if (input.text.length > LARGE_PROMPT_CHARS) {
    say(
      `  要件が長いため、生成に時間がかかるか、要点が薄まる可能性があります。` +
        ` 必要な部分に絞ることを検討してください。`,
    );
  }
  return input;
}

class CliError extends Error {}

function config_(): KintoneConfig {
  return loadKintoneConfig(process.env);
}

/**
 * コマンドの共通の入り口。
 *
 * 想定内のエラーはスタックトレースを出さず、**種類ごとに終了コードを分けて**返す。
 * AI エージェントが「AppSpec を直す」「login する」「再試行する」を判断できるようにするため。
 */
async function run(command: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppSpecValidationError) {
      emitFailure({
        command,
        kind: "validation",
        message: error.message,
        issues: error.issues,
      });
      return;
    }
    if (error instanceof ConfigError) {
      emitFailure({ command, kind: "config", message: error.message });
      return;
    }
    if (error instanceof OAuthError) {
      // ReauthRequiredError も OAuthError を継承している。
      emitFailure({ command, kind: "auth", message: error.message });
      return;
    }
    if (error instanceof UnsupportedUpdateError) {
      emitFailure({ command, kind: "validation", message: error.message });
      return;
    }
    if (error instanceof DeployError) {
      // スコープ不足は「login し直す」なので認証側に寄せる。
      const kind = /スコープ/.test(error.message) ? "auth" : "kintone";
      emitFailure({ command, kind, message: error.message, appId: error.appId });
      return;
    }
    if (error instanceof KintoneRestAPIError || error instanceof KintoneRequestError) {
      emitFailure({ command, kind: "kintone", message: error.message });
      return;
    }
    if (error instanceof AppSpecGenerationError) {
      const issues =
        error.cause instanceof AppSpecValidationError ? error.cause.issues : undefined;
      emitFailure({
        command,
        kind: "generation",
        message: error.message,
        ...(issues === undefined ? {} : { issues }),
      });
      return;
    }
    if (error instanceof PromptInputError || error instanceof CliError) {
      emitFailure({ command, kind: "input", message: error.message });
      return;
    }
    if (error instanceof Anthropic.APIError) {
      emitFailure({
        command,
        kind: "generation",
        message:
          `Claude API がエラーを返しました (HTTP ${error.status ?? "?"}): ${apiErrorMessage(error)}` +
          (error.requestID == null ? "" : `\n  リクエスト ID: ${error.requestID}`),
      });
      return;
    }
    throw error;
  }
}

/** APIError の本文から、人が読むべきメッセージだけを取り出す。 */
function apiErrorMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === "string" ? message : error.message;
}

loadDotEnv();
await program.parseAsync(process.argv);
