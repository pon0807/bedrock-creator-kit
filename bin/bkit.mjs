#!/usr/bin/env node
// bkit — 統合版／教育版アドオン開発の道具（bedrock-creator-kit）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { log, color, parseArgs, runCapture, run, readJson, KIT_ROOT } from "../lib/util.mjs";

// ワークスペースに入っている道具を優先する（グローバルの bkit と版がずれないように）
delegateToLocalKit();

const { loadProject: loadProjectAll, findProjectRoot, selectAddons } = await import("../lib/project.mjs");
const { build, watch } = await import("../lib/build.mjs");
const { typecheck, lint, compat, checkAll, uuidReport } = await import("../lib/check.mjs");
const { validate, release, uuidCommand } = await import("../lib/release.mjs");
const { createProject, addAddon, migrateProject, writeVscode } = await import("../lib/scaffold.mjs");
const { allGameTargets } = await import("../lib/targets.mjs");
const { apiFor, npmVersions } = await import("../lib/compat.mjs");
const { findWorkspace, bdsRoots, KIT_NAME, SETTINGS_FILE } = await import("../lib/settings.mjs");
const { setupWizard, upgradeProject, upgradeAll, initWorkspace, EXTENSIONS, kitReachable } = await import("../lib/workspace.mjs");
const { mainMenu, newWizard, addWizard, pickProject, isInteractive } = await import("../lib/menu.mjs");
const { currentEditor, listExtensions } = await import("../lib/editors.mjs");

const VERSION = readJson(path.join(KIT_ROOT, "package.json")).version;

const HELP = `
${color.bold("bkit")} ${VERSION} — 統合版／教育版アドオンの道具（${KIT_NAME}）

${color.bold("迷ったら")}
  bkit                               メニューを出す（選ぶだけで使える）

${color.bold("はじめに")}
  setup                              初期設定（アドオンの置き場所、エディタと拡張）
  new [名前]                         新しいアドオンを作る（名前を省くと質問形式）
      --packs bp,rp,sp               作るパック（ビヘイビアー / リソース / スキン）
      --targets bedrock,education    送り先（bedrock / preview / education / education-preview / bds）
      --modules server@2.8.0,ui      モジュールと版（版を省くとおすすめの版。--no-modules でスクリプトなし）
      --display 表示名  --author 作者

${color.bold("アドオンのフォルダの中で")}（npm run 〇〇 でも同じ）
  watch [--addon 名前]               変更を見張って、ゲームに送り続ける
  build [--prod] [--no-deploy]       1 回だけ送る
  check [--strict]                   型・書き方・送り先の版・UUID をまとめて確かめる
  lint [--fix]  types  compat        チェックを 1 つずつ
  validate [main|addon|all]          公式の Creator Tools で検証
  release [patch|minor|major|none]   版を上げて dist/ に .mcaddon を作る（アドオンごと。--addon で絞る）
  add [名前] [--requires main]       このプロジェクトにアドオンを足す（名前を省くと質問形式）
  uuid [--fix] [--new N]             UUID の重複を探す / 振り直す / 新しく出す
  vscode                             .vscode（デバッガなど）を作り直す
  upgrade [--all]                    設定ファイルを今の bkit の書き方に揃える

${color.bold("そのほか")}
  doctor                             ゲームの版、使える API の版、道具の状態
  update                             bkit を新しくする
  migrate <フォルダ>                  gulp の古いプロジェクトを移す
  uuid-all                           ワークスペースの中すべての UUID の重複
`;

const PROJECT_COMMANDS = new Set(["watch", "dev", "build", "check", "lint", "types", "compat", "validate", "release", "uuid", "vscode", "add"]);

// --addon で、見張る・送るパックを 1 つのアドオンに絞る
function loadProject(dir, addonSpec) {
  const pr = loadProjectAll(dir);
  if (addonSpec && addonSpec !== true) {
    const keep = new Set(selectAddons(pr, addonSpec).flatMap((a) => a.packs.map((p) => p.name)));
    pr.packs = pr.packs.filter((p) => keep.has(p.name));
  }
  return pr;
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);

  if (!cmd) {
    if (isInteractive()) return mainMenu({ doctor, help: () => console.log(HELP) });
    console.log(HELP);
    return 0;
  }

  // プロジェクトの外でプロジェクト用のコマンドを打ったら、一覧から選ばせる
  if (PROJECT_COMMANDS.has(cmd) && !findProjectRoot(process.cwd())) {
    if (!isInteractive()) {
      log.error("アドオンのフォルダの中で打ってください（addon.config.json があるフォルダ）。bkit とだけ打つと、一覧から選べます");
      return 1;
    }
    process.chdir(await pickProject());
  }
  if (PROJECT_COMMANDS.has(cmd)) {
    const root = findProjectRoot(process.cwd());
    if (!kitReachable(root) && !process.env.BKIT_DELEGATED) {
      log.warn("このアドオンはワークスペースの外にあります。型チェックと ESLint の設定が見つからないかもしれません（ワークスペースの stable\\ に移すか、ここで npm i -D " + KIT_NAME + "）");
    }
  }
  const proj = () => loadProject(process.cwd());

  switch (cmd) {
    case "watch":
    case "dev":
      return watch(loadProject(process.cwd(), args.addon), { only: args.only });
    case "build": {
      const r = await build(loadProject(process.cwd(), args.addon), { mode: args.prod ? "prod" : "dev", deploy: args.deploy !== false, only: args.only });
      return r.ok ? 0 : 1;
    }
    case "check": {
      const pr = proj();
      if (args.strict) { typecheck(pr, { strict: true }); return 0; }
      return checkAll(pr, { only: args.only }).errors ? 1 : 0;
    }
    case "lint":
      return lint(proj(), { fix: !!args.fix }).errors ? 1 : 0;
    case "types":
      return typecheck(proj(), { strict: !!args.strict }).errors ? 1 : 0;
    case "compat":
      return compat(proj(), { only: args.only }).errors ? 1 : 0;
    case "validate":
      return (await validate(proj(), { suite: args._[0] ?? "main" })).errors ? 1 : 0;
    case "release":
      return release(proj(), { kind: args._[0] ?? "patch", force: !!args.force, skipValidate: args.validate === false, addons: args.addon });
    case "add":
      if (!args._[0] && isInteractive()) return addWizard(proj());
      return addAddon(proj(), args);
    case "uuid":
      return uuidCommand(proj(), args);
    case "uuid-all":
      return uuidReport(null).errors ? 1 : 0;
    case "vscode":
      writeVscode(proj().root);
      log.ok(".vscode を作り直しました");
      return 0;
    case "new":
      if (!args._[0] && isInteractive()) return newWizard();
      return createProject(args);
    case "setup":
      if (args.workspace) {
        const code = initWorkspace(path.resolve(String(args.workspace)), { install: args.install !== false });
        if (code === 0) log.ok(`ワークスペースを用意しました: ${path.resolve(String(args.workspace))}`);
        return code;
      }
      return setupWizard({ yes: !!args.yes });
    case "upgrade": {
      if (args.all) return upgradeAll({ install: args.install !== false });
      const root = findProjectRoot(process.cwd());
      if (!root) { log.error("アドオンのフォルダの中で打ってください（全部なら bkit upgrade --all）"); return 1; }
      return upgradeProject(root, { install: args.install !== false });
    }
    case "update":
      return update();
    case "migrate": {
      const targets = args.targets ? String(args.targets).split(",") : undefined;
      let code = 0;
      for (const dir of args._) code ||= migrateProject(path.resolve(dir), { targets, install: args.install !== false, dryRun: !!args["dry-run"] });
      return code;
    }
    case "doctor":
      return doctor();
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      log.error(`知らないコマンドです: ${cmd}（bkit とだけ打つとメニューが出ます）`);
      console.log(HELP);
      return 1;
  }
}

function doctor() {
  console.log(color.bold(`\nbkit ${VERSION}`));
  console.log(color.bold("\nゲームと、使える Script API の版"));
  for (const t of allGameTargets()) {
    if (!t.root && !t.engine) { console.log(`  ${t.label.padEnd(14)} ${color.gray("入っていない")}`); continue; }
    const s = apiFor("@minecraft/server", t.engine);
    const u = apiFor("@minecraft/server-ui", t.engine);
    console.log(`  ${t.label.padEnd(14)} ${t.engine ? t.engine.join(".") : "?"}  server stable ${color.bold(s?.stable ?? "?")} / beta ${s?.beta ?? "?"}  ui stable ${u?.stable ?? "?"}${s && !s.exact ? color.gray("（推定）") : ""}`);
    console.log(color.gray(`  ${"".padEnd(14)} ${t.root ?? "com.mojang が見つからない"}`));
  }
  const servers = bdsRoots().flatMap((r) => fs.readdirSync(r).filter((n) => /^bedrock-server-/.test(n)));
  if (servers.length) {
    console.log(color.bold("\nBDS"));
    for (const n of servers) console.log(`  ${n}`);
  }
  console.log(color.bold("\n道具"));
  const ver = (c, a = ["--version"]) => runCapture(c, a, { shell: true }).stdout.trim().split("\n")[0] || color.gray("なし");
  console.log(`  node ${process.version} / npm ${ver("npm")} / ${ver("git")}`);
  const ed = currentEditor();
  console.log(`  エディタ: ${ed?.label ?? "なし"}${ed?.extensions ? "" : color.gray("（拡張の確認はできない）")}`);
  if (ed?.extensions) {
    const ext = listExtensions(ed);
    for (const [id, label] of EXTENSIONS) console.log(`  ${ext.includes(id) ? color.green("✔") : color.yellow("✖")} ${label}`);
  }
  const cache = npmVersions("@minecraft/server");
  console.log(`  npm の版の記録: ${cache ? `${cache.length} 件` : color.yellow("取れない")}`);
  const ws = findWorkspace();
  console.log(color.gray(`\n  ワークスペース: ${ws ?? "まだない（bkit setup）"}`));
  console.log(color.gray(`  道具の場所:     ${KIT_ROOT}`));
  console.log(color.gray(`  設定:           ${SETTINGS_FILE}`));
  return 0;
}

function update() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (fs.existsSync(path.join(KIT_ROOT, ".git"))) {
    log.info("この bkit は手元のフォルダ（git）から動いています。git pull で新しくしてください");
    return 0;
  }
  log.step("bkit を新しくします");
  let code = run(npm, ["install", "-g", `${KIT_NAME}@latest`, "--no-fund", "--no-audit", "--loglevel=error"], { shell: true });
  const ws = findWorkspace();
  if (code === 0 && ws) code = run(npm, ["install", `${KIT_NAME}@latest`, "--save-dev", "--no-fund", "--no-audit", "--loglevel=error"], { cwd: ws, shell: true });
  if (code === 0) log.ok("新しくしました");
  return code;
}

function delegateToLocalKit() {
  if (process.env.BKIT_DELEGATED) return;
  let d = process.cwd();
  for (;;) {
    const local = path.join(d, "node_modules", "bedrock-creator-kit", "bin", "bkit.mjs");
    if (fs.existsSync(local)) {
      const real = fs.realpathSync(path.dirname(path.dirname(local)));
      if (path.resolve(real) !== path.resolve(fs.realpathSync(KIT_ROOT))) {
        const r = spawnSync(process.execPath, [local, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, BKIT_DELEGATED: "1" } });
        process.exit(r.status ?? 1);
      }
      return;
    }
    const up = path.dirname(d);
    if (up === d) return;
    d = up;
  }
}

main().then(
  (code) => { if (typeof code === "number") process.exitCode = code; },
  (e) => { log.error(e?.message ?? String(e)); if (process.env.BKIT_DEBUG) console.error(e); process.exitCode = 1; },
);
