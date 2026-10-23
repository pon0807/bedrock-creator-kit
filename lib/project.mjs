// プロジェクトの読み込み（addon.config.json と、behavior_packs / resource_packs / skin_packs の中のパック）
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./util.mjs";

export const CONFIG_FILE = "addon.config.json";

// パックの種類: [記号, プロジェクト内のフォルダ, ゲームの開発用フォルダ]
export const PACK_KINDS = [["bp", "behavior_packs"], ["rp", "resource_packs"], ["sp", "skin_packs"]];
export const DEV_DIRS = { bp: "development_behavior_packs", rp: "development_resource_packs", sp: "development_skin_packs" };

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/*.ts",
  "**/package.json",
  "**/package-lock.json",
  "**/tsconfig*.json",
  "**/*.md",
  "**/*.bbmodel",
  "**/*.psd",
  "**/*.kra",
  "**/*.ase",
  "**/*.aseprite",
  "**/*.xcf",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",
  "**/.gitkeep",
];

export function findProjectRoot(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, CONFIG_FILE))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function loadPacks(root) {
  const packs = [];
  for (const [kind, dirName] of PACK_KINDS) {
    const base = path.join(root, dirName);
    if (!fs.existsSync(base)) continue;
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(base, ent.name);
      const mf = path.join(dir, "manifest.json");
      if (!fs.existsSync(mf)) continue;
      const manifest = readJson(mf);
      const script = (manifest.modules ?? []).find((m) => m.type === "script");
      let scriptInfo = null;
      if (script?.entry) {
        const entry = script.entry.replace(/\\/g, "/");
        const noExt = entry.replace(/\.[cm]?js$/, "");
        const cand = [".ts", ".mts", ".js", ".mjs"].map((e) => path.join(dir, noExt + e)).find((f) => fs.existsSync(f));
        scriptInfo = {
          entry,
          source: cand ?? null,
          rootDir: entry.split("/")[0], // 例: scripts
          uuid: script.uuid,
        };
      }
      packs.push({ kind, dirName, name: ent.name, dir, manifestPath: mf, manifest, script: scriptInfo });
    }
  }
  return packs;
}

export function loadProject(start) {
  const root = findProjectRoot(start);
  if (!root) {
    throw new Error(`${CONFIG_FILE} が見つかりません。プロジェクトのフォルダで実行してください（新しく作るときは bkit new）`);
  }
  const config = readJson(path.join(root, CONFIG_FILE));
  config.targets ??= ["bedrock"];
  config.exclude = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])];
  const packs = loadPacks(root);
  return { root, config, packs, name: config.name ?? path.basename(root) };
}

// ---------- プロジェクトの中のアドオン（パックの組） ----------
// addon.config.json の addons: [{ id, display, packs: [フォルダ名...], requires: [id...] }]
// 書かれていなければ、全パックで 1 つのアドオン（今までと同じ）
export function addonsOf(project) {
  const list = project.config.addons;
  if (!Array.isArray(list) || !list.length) {
    return [{ id: "main", display: project.config.display ?? project.name, packs: project.packs, requires: [], implicit: true }];
  }
  return list.map((a) => ({
    id: a.id,
    display: a.display ?? a.id,
    requires: a.requires ?? [],
    packs: (a.packs ?? []).map((n) => project.packs.find((p) => p.name === n)).filter(Boolean),
    missing: (a.packs ?? []).filter((n) => !project.packs.some((p) => p.name === n)),
  }));
}

// どのアドオンにも入っていないパック
export function loosePacks(project) {
  if (!Array.isArray(project.config.addons)) return [];
  const used = new Set(project.config.addons.flatMap((a) => a.packs ?? []));
  return project.packs.filter((p) => !used.has(p.name));
}

// --addon で絞る（カンマ区切り）。無ければ全部
export function selectAddons(project, spec) {
  const all = addonsOf(project);
  if (!spec || spec === true) return all;
  const ids = String(spec).split(",").map((s) => s.trim());
  const hit = all.filter((a) => ids.includes(a.id));
  const unknown = ids.filter((id) => !all.some((a) => a.id === id));
  if (unknown.length) throw new Error(`知らないアドオンです: ${unknown.join(", ")}（このプロジェクトには ${all.map((a) => a.id).join(", ")}）`);
  return hit;
}
