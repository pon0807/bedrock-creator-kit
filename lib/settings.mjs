// 使う人ごとの設定（PC ごと）と、ワークスペース（アドオンを置くフォルダ）
//   設定:        %APPDATA%\bedrock-creator-kit\settings.json
//   ワークスペース: bkit-workspace.json がある フォルダ。中に stable\ と preview\ を置く
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIT_ROOT, readJson, writeJson } from "./util.mjs";

export const KIT_NAME = "bedrock-creator-kit";
export const KIT_REPO = "github:pon0807/bedrock-creator-kit";
// ワークスペースに入れる道具の版（npm）。今動いている道具と同じ版にそろえる
export const kitNpmSpec = () => `^${readJson(path.join(KIT_ROOT, "package.json")).version}`;
export const WORKSPACE_FILE = "bkit-workspace.json";

const base = process.env.APPDATA ?? path.join(os.homedir(), ".config");
// BKIT_SETTINGS で別の設定ファイルを使える（試験用）
export const SETTINGS_FILE = process.env.BKIT_SETTINGS ?? path.join(base, KIT_NAME, "settings.json");

export function loadSettings() {
  try {
    return fs.existsSync(SETTINGS_FILE) ? readJson(SETTINGS_FILE) : {};
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJson(SETTINGS_FILE, next);
  return next;
}

export const isWorkspace = (dir) => !!dir && fs.existsSync(path.join(dir, WORKSPACE_FILE));

// 今いる場所から上にたどってワークスペースを探す → 無ければ設定の場所
export function findWorkspace(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (isWorkspace(d)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const s = loadSettings();
  if (s.workspace && isWorkspace(s.workspace)) return s.workspace;
  // 道具がワークスペースの中にある場合（道具を手元で直している人の形: <ワークスペース>\_toolkit）
  const parent = path.resolve(KIT_ROOT, "..");
  if (isWorkspace(parent)) return parent;
  return null;
}

export function defaultWorkspacePath() {
  return path.join(os.homedir(), "Documents", "MinecraftAddons");
}

// ワークスペースの中のプロジェクトの一覧（新しく触った順）
export function listProjects(ws = findWorkspace()) {
  if (!ws) return [];
  const out = [];
  for (const ch of ["stable", "preview"]) {
    const dir = path.join(ws, ch);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const root = path.join(dir, name);
      const cfg = path.join(root, "addon.config.json");
      if (!fs.existsSync(cfg)) continue;
      let config = {};
      try { config = readJson(cfg); } catch { /* 読めなくても一覧には出す */ }
      out.push({ name, channel: ch, root, config, mtime: newestMtime(root) });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function newestMtime(root) {
  let t = 0;
  for (const sub of ["behavior_packs", "resource_packs", "skin_packs"]) {
    const d = path.join(root, sub);
    if (!fs.existsSync(d)) continue;
    const stack = [d];
    let n = 0;
    while (stack.length && n < 3000) {
      const cur = stack.pop();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = path.join(cur, e.name);
        n++;
        if (e.isDirectory()) stack.push(p);
        else t = Math.max(t, fs.statSync(p).mtimeMs);
      }
    }
  }
  return t;
}

// BDS（サーバー）を探す場所
export function bdsRoots() {
  const s = loadSettings();
  const list = [...(s.bdsRoots ?? [])];
  const ws = findWorkspace();
  if (ws) list.push(path.join(ws, "..", "BE_server"), path.join(ws, "BE_server"));
  return [...new Set(list.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
}
