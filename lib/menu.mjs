// 対話式メニュー（bkit だけで出る）と、質問に答えて作る bkit new
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { color, run, runCapture, writeJson, readJson } from "./util.mjs";
import { findProjectRoot, loadProject, CONFIG_FILE, addonsOf } from "./project.mjs";
import { findWorkspace, listProjects, loadSettings, saveSettings } from "./settings.mjs";
import { allGameTargets, PRODUCTS, resolveTargets } from "./targets.mjs";
import { apiFor, versionChoices, MODULE_INFO } from "./compat.mjs";
import { detectEditors, currentEditor, rememberEditor, openIn } from "./editors.mjs";
import { build, watch } from "./build.mjs";
import { checkAll, compat } from "./check.mjs";
import { validate, release, brarchiveDefault, formatDefault, parseFormats } from "./release.mjs";
import { createProject, addAddon } from "./scaffold.mjs";
import { setupWizard } from "./workspace.mjs";

export const isInteractive = () => !!(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;

const cancelled = (v) => {
  if (p.isCancel(v)) { p.cancel("やめました"); process.exit(0); }
  return v;
};
const tip = (cmd) => p.log.message(color.gray(`次からは ${cmd} と打っても同じことができます`));

// ---------- 入口 ----------
export async function mainMenu({ doctor, help }) {
  const root = findProjectRoot(process.cwd());
  if (root) return projectMenu(loadProject(root), { doctor });
  return homeMenu({ doctor, help });
}

async function homeMenu({ doctor, help }) {
  p.intro(color.bold(" bkit — 統合版アドオンの道具 "));
  const ws = findWorkspace();
  if (!ws) {
    p.log.warn("まだ初期設定がされていません（アドオンを置くフォルダが決まっていない）");
    const ok = cancelled(await p.confirm({ message: "今、初期設定をしますか？", initialValue: true }));
    return ok ? setupWizard() : 0;
  }
  const projects = listProjects(ws);
  const choice = cancelled(await p.select({
    message: "何をしますか？",
    options: [
      { value: "new", label: "新しいアドオンを作る" },
      ...(projects.length ? [{ value: "open", label: "作ったアドオンで作業する", hint: `${projects.length} 個` }] : []),
      { value: "doctor", label: "ゲームと Script API の版を見る" },
      { value: "setup", label: "初期設定をやり直す" },
      { value: "help", label: "コマンドの一覧を見る" },
    ],
  }));
  if (choice === "new") return newWizard();
  if (choice === "doctor") { doctor(); tip("bkit doctor"); return 0; }
  if (choice === "setup") return setupWizard();
  if (choice === "help") { help(); return 0; }
  const pick = await pickProject(projects);
  process.chdir(pick);
  return projectMenu(loadProject(pick), { doctor });
}

export async function pickProject(projects = listProjects()) {
  if (!projects.length) { p.log.warn("まだアドオンがありません。bkit new で作れます"); process.exit(0); }
  return cancelled(await p.select({
    message: "どのアドオンですか？（新しく触った順）",
    maxItems: 12,
    options: projects.map((x) => ({
      value: x.root,
      label: x.config.display && x.config.display !== x.name ? `${x.name}（${x.config.display}）` : x.name,
      hint: [x.channel === "preview" ? "preview" : "", (x.config.targets ?? []).map((t) => PRODUCTS[t]?.label ?? (typeof t === "string" ? t : t.type)).join("・")].filter(Boolean).join(" / "),
    })),
  }));
}

// ---------- プロジェクトの中 ----------
async function projectMenu(project, { doctor }) {
  p.intro(color.bold(` ${project.config.display ?? project.name} `));
  const targets = (project.config.targets ?? []).map((t) => PRODUCTS[t]?.label ?? (typeof t === "string" ? t : t.type)).join("・");
  const choice = cancelled(await p.select({
    message: `何をしますか？（送り先: ${targets || "なし"}）`,
    options: [
      { value: "watch", label: "書きながらゲームに送り続ける", hint: "npm run watch" },
      { value: "build", label: "1 回だけゲームに送る", hint: "npm run build" },
      { value: "check", label: "まちがいがないか確かめる", hint: "npm run check" },
      { value: "validate", label: "公式の検証にかける", hint: "npm run validate" },
      { value: "release", label: "配布・納品用のファイルを作る", hint: "npm run release" },
      { value: "add", label: "このプロジェクトにアドオンを足す（拡張・別の機能）", hint: `今 ${addonsOf(project).length} 個` },
      { value: "targets", label: "送り先を変える（統合版・教育版など）" },
      { value: "code", label: `エディタで開く（${currentEditor()?.label ?? "なし"}）` },
      { value: "doctor", label: "ゲームと Script API の版を見る" },
    ],
  }));
  switch (choice) {
    case "watch":
      p.outro("見張りを始めます。止めるときは Ctrl+C");
      return watch(project);
    case "build": {
      const r = await build(project);
      tip("npm run build");
      return r.ok ? 0 : 1;
    }
    case "check": {
      const r = checkAll(project);
      tip("npm run check");
      return r.errors ? 1 : 0;
    }
    case "validate": {
      const r = await validate(project);
      tip("npm run validate");
      return r.errors ? 1 : 0;
    }
    case "add":
      return addWizard(project);
    case "release": {
      // アドオンが複数なら、どれを出すかを選ぶ
      const all = addonsOf(project);
      let picked = all;
      if (all.length > 1) {
        const ids = cancelled(await p.multiselect({
          message: "どのアドオンの配布ファイルを作りますか？（アドオンごとに別のファイル・別の版）",
          options: all.map((x) => ({ value: x.id, label: `${x.display}（${x.id}）`, hint: `今の版 ${verText(x)}${x.requires.length ? `・${x.requires.join("・")} が要る` : ""}` })),
          initialValues: all.map((x) => x.id),
          required: true,
        }));
        picked = all.filter((x) => ids.includes(x.id));
      }
      const v = picked[0]?.packs[0]?.manifest.header.version ?? [1, 0, 0];
      const [a, b, c] = Array.isArray(v) ? v : String(v).split(".").map(Number);
      const kind = cancelled(await p.select({
        message: picked.length > 1 ? "版をどう上げますか？（選んだアドオンそれぞれの今の版から上げる）" : `今の版は ${a}.${b}.${c} です。どう上げますか？`,
        options: [
          { value: "patch", label: `小さな直し → ${a}.${b}.${c + 1}` },
          { value: "minor", label: `機能を足した → ${a}.${b + 1}.0` },
          { value: "major", label: `大きく変えた → ${a + 1}.0.0` },
          { value: "none", label: `上げずに作る（${a}.${b}.${c} のまま）` },
        ],
      }));
      let defFormats;
      try { defFormats = formatDefault(project); } catch { defFormats = ["mcaddon"]; }
      const formats = cancelled(await p.multiselect({
        message: "どの形式で作りますか？（いくつでも）",
        options: [
          { value: "mcaddon", label: ".mcaddon", hint: "パックを 1 つにまとめる。ダブルクリックで入る" },
          { value: "mcpack", label: ".mcpack", hint: "パックごとに 1 つずつ" },
          { value: "zip", label: ".zip", hint: "中身は .mcaddon と同じ。納品やファイル共有のサイト向け" },
        ],
        initialValues: defFormats,
        required: true,
      }));
      const brarchive = cancelled(await p.confirm({
        message: "中身を .brarchive にまとめますか？（公式のパックと同じ形。ファイルの数が減り、少し小さくなる）",
        initialValue: brarchiveDefault(project),
      }));
      const spec = all.length > 1 ? picked.map((x) => x.id).join(",") : undefined;
      const code = await release(project, { kind, addons: spec, brarchive, formats });
      const def = brarchiveDefault(project);
      const sameFormats = parseFormats(formats).join(",") === defFormats.join(",");
      tip(`npm run release -- ${kind}${spec ? ` --addon ${spec}` : ""}${sameFormats ? "" : ` --format ${parseFormats(formats).join(",")}`}${brarchive !== def ? (brarchive ? " --brarchive" : " --no-brarchive") : ""}`);
      return code;
    }
    case "targets":
      return editTargets(project);
    case "code": {
      const editors = detectEditors();
      const id = cancelled(await p.select({ message: "どのアプリで開きますか？", options: editors.map((e) => ({ value: e.id, label: e.label })), initialValue: currentEditor()?.id }));
      rememberEditor(id);
      openIn(editors.find((e) => e.id === id), project.root);
      return 0;
    }
    case "doctor":
      doctor();
      tip("bkit doctor");
      return 0;
  }
  return 0;
}

function gameOptions() {
  return allGameTargets().map((g) => {
    const api = apiFor("@minecraft/server", g.engine);
    const installed = !!(g.root || g.engine);
    return {
      value: g.id,
      label: g.label,
      hint: installed ? `${g.engine?.join(".") ?? "?"}・Script API ${api?.stable ?? "?"} まで` : "この PC には入っていない",
    };
  });
}

async function editTargets(project) {
  const file = path.join(project.root, CONFIG_FILE);
  const cfg = readJson(file);
  const current = (cfg.targets ?? []).map((t) => (typeof t === "string" ? t : t.type));
  const opts = gameOptions();
  if (cfg.bds || current.includes("bds")) opts.push({ value: "bds", label: "BDS（サーバー）", hint: cfg.bds?.server ?? "" });
  const next = cancelled(await p.multiselect({
    message: "どのゲームに送りますか？（スペースで選ぶ、Enter で決定）",
    options: opts,
    initialValues: current.filter((t) => opts.some((o) => o.value === t)),
    required: true,
  }));
  cfg.targets = next;
  writeJson(file, cfg);
  p.log.success(`送り先を ${next.map((t) => PRODUCTS[t]?.label ?? t).join("・")} にしました`);
  compat(loadProject(project.root));
  p.log.message(color.gray("manifest の API の版が送り先で動かないときは、上に ✖ が出ます"));
  return 0;
}

// ---------- 新しく作る（質問に答えるだけ） ----------
export async function newWizard() {
  p.intro(color.bold(" 新しいアドオンを作る "));
  const ws = findWorkspace();
  if (!ws) {
    p.log.warn("先に初期設定が要ります");
    return setupWizard();
  }

  // 1. 名前
  const name = cancelled(await p.text({
    message: "名前は？（英数字。フォルダの名前になります）",
    placeholder: "MyAddon",
    validate: (v) => {
      if (!v) return "名前を入れてください";
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(v)) return "英字で始まる英数字（_ と - も可）にしてください。日本語の名前は次で入れます";
      if (fs.existsSync(path.join(ws, "stable", v)) || fs.existsSync(path.join(ws, "preview", v))) return "同じ名前のアドオンがもうあります";
    },
  }));
  const display = cancelled(await p.text({ message: "ゲームの中で見える名前は？（日本語でよい）", placeholder: name, defaultValue: name }));

  // 2. 作るパック
  const packs = cancelled(await p.multiselect({
    message: "作るパックは？（スペースで選ぶ、Enter で決定）",
    options: [
      { value: "bp", label: "ビヘイビアーパック（BP）", hint: "動き・スクリプト・アイテムやブロックの性質" },
      { value: "rp", label: "リソースパック（RP）", hint: "見た目・テクスチャ・モデル・音" },
      { value: "sp", label: "スキンパック（SP）", hint: "プレイヤーのスキン" },
    ],
    initialValues: ["bp", "rp"],
    required: true,
  }));

  // 3. 送り先
  const opts = gameOptions();
  const installed = opts.filter((o) => !o.hint.includes("入っていない")).map((o) => o.value);
  const targetIds = cancelled(await p.multiselect({
    message: "どのゲームで動かしますか？（スペースで選ぶ、Enter で決定）",
    options: opts.map((o) => (o.value === "education" ? { ...o, hint: `${o.hint}・選ぶと使える API が古い版に揃う` } : o)),
    initialValues: installed.includes("bedrock") ? ["bedrock"] : installed.slice(0, 1),
    required: true,
  }));
  const targets = resolveTargets({ root: ws, config: { targets: targetIds } });

  // 4. モジュールと、その版（BP を作るときだけ）
  const modules = [];
  if (packs.includes("bp")) {
    const picked = cancelled(await p.multiselect({
      message: "使うモジュールは？（何も選ばなければスクリプトなし）",
      options: Object.entries(MODULE_INFO).map(([id, info]) => ({
        value: id,
        label: id,
        hint: `${info.kind === "lib" ? "ライブラリ・" : ""}${info.label}${info.bdsOnly ? "・BDS だけ" : ""}`,
      })),
      initialValues: ["@minecraft/server"],
      required: false,
    }));
    // server-ui などは server が要る
    for (const id of [...picked]) {
      const need = MODULE_INFO[id]?.needs;
      if (need && !picked.includes(need)) {
        picked.unshift(need);
        p.log.info(`${id} は ${need} が要るので、足しました`);
      }
    }
    for (const id of picked) {
      const { options, recommended } = versionChoices(id, targets);
      if (!options.length) { p.log.warn(`${id} の版の一覧が取れませんでした（ネットにつながっているか確認）`); continue; }
      const version = cancelled(await p.select({
        message: `${id} の版は？`,
        options,
        initialValue: recommended,
        maxItems: 10,
      }));
      modules.push({ name: id, version });
    }
  }

  // 5. 作者（manifest の metadata.authors に入る）
  const s = loadSettings();
  const git = runCapture("git", ["config", "user.name"], { shell: true });
  const author = cancelled(await p.text({
    message: "作者の名前は？（manifest に書かれます）",
    placeholder: s.author || git.stdout.trim() || "名前",
    defaultValue: s.author || git.stdout.trim() || "unknown",
  }));
  if (author && author !== s.author) saveSettings({ author });

  const channel = targetIds.every((t) => t.includes("preview")) ? "preview" : "stable";
  const root = path.join(ws, channel, name);
  const packLabel = { bp: "BP", rp: "RP", sp: "スキンパック" };
  p.note([
    `名前        ${name}（${display}）`,
    `パック      ${packs.map((x) => packLabel[x]).join("・")}`,
    `送り先      ${targetIds.map((t) => PRODUCTS[t]?.label ?? t).join("・")}`,
    `モジュール  ${modules.length ? modules.map((m) => `${m.name} ${m.version}`).join("\n            ") : "なし（スクリプトなし）"}`,
    `作者        ${author}`,
    `置き場所    ${root}`,
  ].join("\n"), "これで作ります");
  if (!cancelled(await p.confirm({ message: "作りますか？", initialValue: true }))) { p.cancel("やめました"); return 0; }

  const code = await createProject({ _: [name], display, targets: targetIds.join(","), packs: packs.join(","), modules: modules.length ? modules : false, author });
  if (code !== 0) return code;

  // 6. 開くアプリ
  const editors = detectEditors();
  const cur = currentEditor();
  const choice = cancelled(await p.select({
    message: "どのアプリで開きますか？",
    options: [...editors.map((e) => ({ value: e.id, label: e.label })), { value: "none", label: "開かない" }],
    initialValue: cur?.id ?? "none",
  }));
  if (choice !== "none") {
    rememberEditor(choice);
    openIn(editors.find((e) => e.id === choice), root);
  }
  const bpDir = `${name.replace(/[-\s]/g, "")}_mainBP`;
  p.note([
    "1. エディタで npm run watch（VS Code 系なら Ctrl+Shift+B）",
    "2. ゲームで新しいワールドを作り、作ったパックを入れる",
    ...(modules.some((m) => MODULE_INFO[m.name]?.kind === "module") ? [`3. behavior_packs\\${bpDir}\\scripts\\main.ts を書き換えて、ゲームで /reload`] : []),
  ].join("\n"), "次にすること");
  const modSpec = modules.map((m) => `${m.name.replace("@minecraft/", "")}@${m.version}`).join(",");
  p.outro(color.gray(`次からは bkit new ${name} --packs ${packs.join(",")} --targets ${targetIds.join(",")}${modSpec ? ` --modules ${modSpec}` : " --no-modules"} でも作れます`));
  return 0;
}

const verText = (addon) => {
  const v = addon.packs[0]?.manifest.header.version ?? "1.0.0";
  return Array.isArray(v) ? v.join(".") : v;
};

// ---------- 今あるプロジェクトにアドオンを足す（bkit add） ----------
export async function addWizard(project) {
  const existing = addonsOf(project);
  p.intro(color.bold(` ${project.config.display ?? project.name} にアドオンを足す `));
  p.log.info(`今あるアドオン: ${existing.map((a) => `${a.display}（${a.id}）`).join("・")}`);
  const packBase = (project.config.name ?? project.name).replace(/[-\s]/g, "");
  const id = cancelled(await p.text({
    message: `アドオンの名前は？（英数字。パックは ${packBase}_<名前>BP のようになります）`,
    placeholder: "extra",
    validate: (v) => {
      if (!v) return "名前を入れてください";
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(v)) return "英字で始まる英数字にしてください（_ と - は使えません）";
      if (existing.some((a) => a.id === v)) return "同じ名前のアドオンがもうあります";
    },
  }));
  const display = cancelled(await p.text({ message: "ゲームの中で見える名前は？（日本語でよい）", placeholder: id, defaultValue: id }));
  const packs = cancelled(await p.multiselect({
    message: "作るパックは？（スペースで選ぶ、Enter で決定）",
    options: [
      { value: "bp", label: "ビヘイビアーパック（BP）", hint: "動き・スクリプト・アイテムやブロックの性質" },
      { value: "rp", label: "リソースパック（RP）", hint: "見た目・テクスチャ・モデル・音" },
      { value: "sp", label: "スキンパック（SP）", hint: "プレイヤーのスキン" },
    ],
    initialValues: ["bp", "rp"],
    required: true,
  }));
  const requires = cancelled(await p.multiselect({
    message: "このアドオンが使う（無いと動かない）アドオンは？（拡張なら本体を選ぶ。独立した機能なら何も選ばない）",
    options: existing.map((a) => ({ value: a.id, label: `${a.display}（${a.id}）` })),
    initialValues: [],
    required: false,
  }));

  // モジュール: 版は、ほかのアドオンで使っている版を最初に選んでおく（型は 1 つしか入らないため）
  const targets = resolveTargets(project);
  const usedVersion = (name) => project.packs.flatMap((x) => x.manifest.dependencies ?? []).find((d) => d.module_name === name)?.version;
  const pj = path.join(project.root, "package.json");
  const usedLib = (name) => (fs.existsSync(pj) ? readJson(pj).dependencies?.[name] : undefined);
  const modules = [];
  if (packs.includes("bp")) {
    const picked = cancelled(await p.multiselect({
      message: "使うモジュールは？（何も選ばなければスクリプトなし）",
      options: Object.entries(MODULE_INFO).map(([mid, info]) => ({ value: mid, label: mid, hint: `${info.kind === "lib" ? "ライブラリ・" : ""}${info.label}${info.bdsOnly ? "・BDS だけ" : ""}${usedVersion(mid) || usedLib(mid) ? "・ほかのアドオンで使用中" : ""}` })),
      initialValues: ["@minecraft/server"],
      required: false,
    }));
    for (const mid of [...picked]) {
      const need = MODULE_INFO[mid]?.needs;
      if (need && !picked.includes(need)) { picked.unshift(need); p.log.info(`${mid} は ${need} が要るので、足しました`); }
    }
    for (const mid of picked) {
      const { options, recommended } = versionChoices(mid, targets);
      const used = usedVersion(mid) ?? (usedLib(mid) ?? "").replace(/^[\^~]/, "");
      const opts = used && !options.some((o) => o.value === used) ? [{ value: used, label: used, hint: "ほかのアドオンと同じ" }, ...options] : options.map((o) => (o.value === used ? { ...o, hint: [o.hint, "ほかのアドオンと同じ"].filter(Boolean).join("・") } : o));
      const version = cancelled(await p.select({ message: `${mid} の版は？`, options: opts, initialValue: used || recommended, maxItems: 10 }));
      modules.push({ name: mid, version });
    }
  }
  const s = loadSettings();
  p.note([
    `アドオン    ${display}（${id}）`,
    `パック      ${packs.map((x) => ({ bp: "BP", rp: "RP", sp: "スキンパック" }[x])).join("・")}`,
    `使うアドオン ${requires.length ? requires.join("・") : "なし（独立）"}`,
    `モジュール  ${modules.length ? modules.map((m) => `${m.name} ${m.version}`).join("\n            ") : "なし（スクリプトなし）"}`,
  ].join("\n"), "これで足します");
  if (!cancelled(await p.confirm({ message: "足しますか？", initialValue: true }))) { p.cancel("やめました"); return 0; }
  const code = await addAddon(project, { _: [id], display, packs: packs.join(","), modules: modules.length ? modules : false, requires: requires.join(",") || undefined, author: s.author });
  if (code === 0) {
    const modSpec = modules.map((m) => `${m.name.replace("@minecraft/", "")}@${m.version}`).join(",");
    p.outro(color.gray(`次からは bkit add ${id} --packs ${packs.join(",")}${requires.length ? ` --requires ${requires.join(",")}` : ""}${modSpec ? ` --modules ${modSpec}` : " --no-modules"} でも足せます`));
  }
  return code;
}
