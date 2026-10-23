// 初期設定（bkit setup）、ワークスペースの作成、プロジェクトの書き直し（bkit upgrade）
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { log, color, KIT_ROOT, readJson, writeJson, run, runCapture, toPosix } from "./util.mjs";
import { KIT_NAME, kitNpmSpec, WORKSPACE_FILE, findWorkspace, isWorkspace, defaultWorkspacePath, saveSettings, loadSettings, listProjects, SETTINGS_FILE } from "./settings.mjs";
import { allGameTargets } from "./targets.mjs";
import { detectEditors, currentEditor, rememberEditor, listExtensions, installExtension } from "./editors.mjs";
import { apiFor } from "./compat.mjs";
import { writeTsconfig, writeEslintConfig, writeVscode, writeProjectClaudeMd, writePackageJson, writeNpmrc, writeGitignore } from "./scaffold.mjs";
import { loadPacks } from "./project.mjs";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const kitVersion = () => readJson(path.join(KIT_ROOT, "package.json")).version;

export const EXTENSIONS = [
  ["blockceptionltd.blockceptionvscodeminecraftbedrockdevelopmentextension", "Blockception（JSON の補完と検査）"],
  ["mojang-studios.minecraft-debugger", "Minecraft Debugger（デバッガ）"],
  ["dbaeumer.vscode-eslint", "ESLint（書き方の指摘）"],
  ["jannisx11.snowstorm", "Snowstorm（パーティクルの編集）"],
];

// ワークスペースへの道具の入れ方
//   ふつう: devDependencies に GitHub（または設定の kitSource）
//   道具を手元で直している（ワークスペースの中に git つきの道具がある）: npm の workspaces でつなぐ
//   （file: でつなぐと、npm が道具の部品をワークスペース側へ移し、peer の react なども入らないため）
function kitLink(ws) {
  const s = loadSettings();
  // セットアップ.cmd（zip で配ったもの）から: その中身をワークスペースに写して使う
  const tgz = process.env.BKIT_KIT_TGZ;
  if (tgz && fs.existsSync(tgz)) {
    const dir = path.join(ws, ".bkit-kit");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(tgz, path.join(dir, path.basename(tgz)));
    return { spec: `file:./.bkit-kit/${path.basename(tgz)}` };
  }
  if (s.kitSource) return { spec: s.kitSource };
  const rel = toPosix(path.relative(ws, KIT_ROOT));
  if (fs.existsSync(path.join(KIT_ROOT, ".git")) && !rel.startsWith("..") && !path.isAbsolute(rel)) return { workspace: rel };
  return { spec: kitNpmSpec() };
}

export function initWorkspace(ws, { install = true } = {}) {
  fs.mkdirSync(path.join(ws, "stable"), { recursive: true });
  fs.mkdirSync(path.join(ws, "preview"), { recursive: true });
  const marker = path.join(ws, WORKSPACE_FILE);
  if (!fs.existsSync(marker)) writeJson(marker, { kit: KIT_NAME, created: new Date().toISOString().slice(0, 10) });
  const pj = path.join(ws, "package.json");
  const pkg = fs.existsSync(pj) ? readJson(pj) : { name: "bkit-workspace", private: true, description: "統合版アドオンのワークスペース（bkit）" };
  const link = kitLink(ws);
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), eslint: "^9.17.0" };
  if (link.workspace) {
    delete pkg.devDependencies[KIT_NAME];
    pkg.workspaces = [...new Set([...(pkg.workspaces ?? []), link.workspace])];
  } else {
    pkg.devDependencies[KIT_NAME] = link.spec;
  }
  writeJson(pj, pkg);
  const stray = path.join(ws, ".npmrc");
  if (fs.existsSync(stray) && /bkit/.test(fs.readFileSync(stray, "utf8"))) fs.rmSync(stray); // 前の版の bkit が置いたもの
  // .npmrc の legacy-peer-deps はワークスペースには置かない（Creator Tools が使う react などが入らなくなる）
  const gi = path.join(ws, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "node_modules/\n");
  const readme = path.join(ws, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `# アドオンのワークスペース\n\nbkit（${KIT_NAME}）で作るアドオンの置き場所。\n\n- \`stable\\\` … 統合版・教育版向け\n- \`preview\\\` … Preview 向け\n\n迷ったら、このフォルダで \`bkit\` と打つとメニューが出る。\n`);
  }
  if (install) {
    log.step("道具をワークスペースに入れています（初回は数分かかります）");
    const code = run(npmCmd, ["install", "--no-fund", "--no-audit", "--loglevel=error"], { cwd: ws, shell: true });
    if (code !== 0) return code;
  }
  saveSettings({ workspace: toPosix(ws) });
  return 0;
}

const cancelled = (v) => {
  if (p.isCancel(v)) { p.cancel("やめました"); process.exit(0); }
  return v;
};

// bkit setup（対話式）
export async function setupWizard({ yes = false } = {}) {
  p.intro(color.bold(` bkit の初期設定（${KIT_NAME} ${kitVersion()}） `));

  // 1. 道具
  const node = process.versions.node.split(".").map(Number);
  const okNode = node[0] >= 20;
  const git = runCapture("git", ["--version"], { shell: true });
  const editors = detectEditors().filter((e) => e.id !== "explorer");
  p.log.info([
    `${okNode ? "✔" : "✖"} Node.js ${process.version}${okNode ? "" : "（20 以上が要ります。https://nodejs.org から LTS を入れてください）"}`,
    `${git.status === 0 ? "✔" : "⚠"} git ${git.status === 0 ? git.stdout.trim().replace("git version ", "") : "なし（無くても使えます。チームで共有するなら https://git-scm.com から）"}`,
    `${editors.length ? "✔" : "⚠"} エディタ ${editors.length ? editors.map((e) => e.label).join("・") : "なし（VS Code か、VS Code 系のエディタがおすすめ）"}`,
  ].join("\n"));
  if (!okNode) { p.outro("Node.js を入れてから、もう一度 bkit setup してください"); return 1; }

  // 2. ゲーム
  const games = allGameTargets();
  p.log.info("入っている Minecraft\n" + games.map((g) => {
    if (!g.root && !g.engine) return `  ・${g.label}: 入っていない`;
    const a = apiFor("@minecraft/server", g.engine);
    return `  ✔ ${g.label} ${g.engine ? g.engine.join(".") : "?"}（使える Script API: ${a?.stable ?? "?"}）`;
  }).join("\n"));

  // 3. ワークスペース
  let ws = findWorkspace();
  if (ws) {
    p.log.success(`アドオンの置き場所: ${ws}`);
  } else {
    const answer = yes ? defaultWorkspacePath() : cancelled(await p.text({
      message: "アドオンを置くフォルダ（ワークスペース）はどこにしますか？",
      placeholder: defaultWorkspacePath(),
      defaultValue: defaultWorkspacePath(),
    }));
    ws = path.resolve(answer || defaultWorkspacePath());
  }
  const needInstall = !fs.existsSync(path.join(ws, "node_modules", KIT_NAME));
  if (!isWorkspace(ws) || needInstall) {
    const code2 = initWorkspace(ws);
    if (code2 !== 0) { p.outro(color.red("道具を入れられませんでした。ネットにつながっているかを確かめて、もう一度 bkit setup してください")); return 1; }
  } else {
    saveSettings({ workspace: toPosix(ws) });
  }
  p.log.success(`ワークスペース: ${ws}`);

  // 4. ふだん使うエディタと、その拡張
  if (editors.length) {
    const cur = currentEditor();
    const id = yes ? cur?.id : cancelled(await p.select({
      message: "ふだん使うエディタは？（アドオンを開くときに使います）",
      options: [...editors.map((e) => ({ value: e.id, label: e.label })), { value: "explorer", label: "エクスプローラー（フォルダを開くだけ）" }],
      initialValue: cur?.id,
    }));
    rememberEditor(id);
    const ed = detectEditors().find((e) => e.id === id);
    if (ed?.extensions) {
      const have = listExtensions(ed);
      const missing = EXTENSIONS.filter(([x]) => !have.includes(x));
      if (missing.length) {
        const ok = yes || cancelled(await p.confirm({ message: `${ed.label} に拡張を ${missing.length} 個入れますか？\n${missing.map(([, l]) => "  ・" + l).join("\n")}`, initialValue: true }));
        if (ok) for (const [x, label] of missing) {
          const done = installExtension(ed, x);
          (done ? p.log.success : p.log.warn)(`${label}${done ? "" : ` を入れられませんでした（${ed.label} の拡張の画面で「${x}」を探して入れてください）`}`);
        }
      } else p.log.success(`${ed.label} の拡張はそろっています`);
    }
  }

  // 5. 教育版のデバッガ（UWP 版はループバックの許可が要る）
  const edu = games.find((g) => g.id === "education" && g.root);
  if (edu && edu.root.includes("Packages")) {
    p.log.info(color.gray("教育版でデバッガを使うときは、管理者の PowerShell で一度だけ:\n  CheckNetIsolation LoopbackExempt -a -n=\"Microsoft.MinecraftEducationEdition_8wekyb3d8bbwe\""));
  }

  p.note([
    "bkit                メニューを出す（迷ったらこれ）",
    "bkit new            新しいアドオンを作る（質問に答えるだけ）",
    "npm run watch       プロジェクトの中で、ゲームに送り続ける",
  ].join("\n"), "使い方");
  p.outro(`設定は ${SETTINGS_FILE} に保存しました`);
  return 0;
}

// 既存プロジェクトを、今の書き方に揃える（tsconfig・ESLint・.vscode・package.json・CLAUDE.md）
export function upgradeProject(root, { install = true } = {}) {
  const name = path.basename(root);
  const tsf = path.join(root, "tsconfig.json");
  if (fs.existsSync(tsf)) {
    const old = readJson(tsf);
    const strict = old.compilerOptions?.strict !== false;
    const dom = (old.compilerOptions?.lib ?? []).some((l) => String(l).toLowerCase() === "dom");
    writeTsconfig(root, { strict, dom });
  }
  writeEslintConfig(root, { force: false });
  const pj = path.join(root, "package.json");
  if (fs.existsSync(pj)) {
    const old = readJson(pj);
    writePackageJson(root, { name: old.name ?? name, keep: old });
  }
  writeGitignore(root);
  writeVscode(root);
  const cm = path.join(root, "CLAUDE.md");
  if (fs.existsSync(cm) && fs.readFileSync(cm, "utf8").includes("<!-- bkit -->")) writeProjectClaudeMd(root, { name, display: name });
  writeNpmrc(root);
  if (install) {
    const code = run(npmCmd, ["install", "--no-fund", "--no-audit", "--loglevel=error"], { cwd: root, shell: true });
    if (code !== 0) { log.warn(`${name}: npm install に失敗しました`); return 1; }
  }
  log.ok(`${name}: 今の書き方に揃えました`);
  return 0;
}

export function upgradeAll(opts) {
  let code = 0;
  for (const pr of listProjects()) code ||= upgradeProject(pr.root, opts);
  return code;
}

// プロジェクトがワークスペースの外にあって、道具が見つからないとき
export function kitReachable(root) {
  let d = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(d, "node_modules", KIT_NAME))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

export { loadPacks };
