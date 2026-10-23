// 送り先（本体 / Preview / 教育版 / 教育版 Preview / BDS / 任意のフォルダ）と、ゲームの版の読み取り
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCapture, readJson, writeJsonKeepStyle, log } from "./util.mjs";
import { DEV_DIRS } from "./project.mjs";

const APPDATA = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const pkgDir = (name) => path.join(LOCAL, "Packages", `${name}_8wekyb3d8bbwe`, "LocalState", "games", "com.mojang");

export const PRODUCTS = {
  bedrock: {
    label: "統合版",
    roots: [path.join(APPDATA, "Minecraft Bedrock", "Users", "Shared", "games", "com.mojang"), pkgDir("Microsoft.MinecraftUWP")],
    gdkConfig: ["C:/XboxGames/Minecraft for Windows/Content/MicrosoftGame.config"],
    appx: "Microsoft.MinecraftUWP",
    debug: true,
  },
  preview: {
    label: "統合版 Preview",
    roots: [path.join(APPDATA, "Minecraft Bedrock Preview", "Users", "Shared", "games", "com.mojang"), pkgDir("Microsoft.MinecraftWindowsBeta")],
    gdkConfig: ["C:/XboxGames/Minecraft Preview for Windows/Content/MicrosoftGame.config"],
    appx: "Microsoft.MinecraftWindowsBeta",
    debug: true,
  },
  education: {
    label: "教育版",
    roots: [pkgDir("Microsoft.MinecraftEducationEdition"), path.join(APPDATA, "Minecraft Education Edition", "games", "com.mojang")],
    appx: "Microsoft.MinecraftEducationEdition",
    debug: false,
  },
  "education-preview": {
    label: "教育版 Preview",
    roots: [pkgDir("Microsoft.MinecraftEducationPreview")],
    appx: "Microsoft.MinecraftEducationPreview",
    debug: false,
  },
};

let appxCache = null;
function appxVersions() {
  if (appxCache) return appxCache;
  appxCache = {};
  if (process.platform !== "win32") return appxCache;
  const r = runCapture("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-AppxPackage -Name 'Microsoft.Minecraft*' | ForEach-Object { $_.Name + '=' + $_.Version }",
  ]);
  for (const line of r.stdout.split(/\r?\n/)) {
    const [k, v] = line.trim().split("=");
    if (k && v) appxCache[k] = v;
  }
  return appxCache;
}

// "1.26.5203.0" → [1,26,52]（Windows のパッケージ版はパッチ番号が 2 桁ずれる）
function packageVersionToEngine(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const third = Number(m[3]);
  return [Number(m[1]), Number(m[2]), third >= 100 ? Math.floor(third / 100) : third];
}

// テスト用: BKIT_GAMES_ROOT を指定すると、<そのフォルダ>/<bedrock など>/ をゲームのフォルダとみなし、
// 中の version.txt（例: 1.26.52）を版として使う。本物のゲームは見ない
const FAKE = process.env.BKIT_GAMES_ROOT;
function fakeGame(id) {
  const root = path.join(FAKE, id);
  if (!fs.existsSync(root)) return { root: null, engine: null, raw: null };
  const vf = path.join(root, "version.txt");
  const raw = fs.existsSync(vf) ? fs.readFileSync(vf, "utf8").trim() : null;
  return { root, engine: raw ? raw.split(".").slice(0, 3).map(Number) : null, raw };
}
export function gameInfo(id) {
  const p = PRODUCTS[id];
  if (FAKE) return fakeGame(id);
  const root = p.roots.find((r) => fs.existsSync(r)) ?? null;
  return { root, ...productEngine(p) };
}

function productEngine(product) {
  for (const f of product.gdkConfig ?? []) {
    if (fs.existsSync(f)) {
      const m = fs.readFileSync(f, "utf8").match(/<Identity[^>]*Version="([\d.]+)"/) ?? fs.readFileSync(f, "utf8").match(/Version="([\d.]+)"/);
      if (m) return { engine: packageVersionToEngine(m[1]), raw: m[1] };
    }
  }
  const v = appxVersions()[product.appx];
  if (v) return { engine: packageVersionToEngine(v), raw: v };
  return { engine: null, raw: null };
}

function bdsEngine(serverDir, config) {
  if (config?.version) return { engine: config.version.split(".").slice(0, 3).map(Number), raw: config.version };
  const m = path.basename(serverDir).match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (m) return { engine: [Number(m[1]), Number(m[2]), Number(m[3])], raw: m[0] };
  // フォルダ名に版が無いときは、exe のファイル情報から読む
  const exe = path.join(serverDir, "bedrock_server.exe");
  if (process.platform === "win32" && fs.existsSync(exe)) {
    const r = runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`]);
    const mm = r.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (mm) return { engine: [Number(mm[1]), Number(mm[2]), Number(mm[3])], raw: r.stdout.trim() };
  }
  const notes = path.join(serverDir, "release-notes.txt");
  if (fs.existsSync(notes)) {
    const mm = fs.readFileSync(notes, "utf8").match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    if (mm) return { engine: [Number(mm[1]), Number(mm[2]), Number(mm[3])], raw: mm[0] };
  }
  return { engine: null, raw: null };
}

// 設定の targets を、実際のフォルダと版に解決する
export function resolveTargets(project, only) {
  const list = [];
  const wanted = only ? String(only).split(",").map((s) => s.trim()).filter(Boolean) : project.config.targets;
  for (const t of wanted) {
    const id = typeof t === "string" ? t : t.id ?? t.type;
    if (PRODUCTS[id]) {
      const p = PRODUCTS[id];
      const { root, engine, raw } = gameInfo(id);
      list.push({ id, label: p.label, root, engine, raw, debug: p.debug, kind: "game" });
    } else if (id === "bds" || id.startsWith("bds:")) {
      const cfg = typeof t === "object" ? t : project.config.bds ?? {};
      const server = cfg.server ? path.resolve(project.root, cfg.server) : null;
      const root = server && fs.existsSync(server) ? server : null;
      const { engine, raw } = server ? bdsEngine(server, cfg) : { engine: null, raw: null };
      list.push({ id: "bds", label: `BDS（${server ? path.basename(server) : "未設定"}）`, root, engine, raw, debug: true, kind: "bds", world: cfg.world, server });
    } else if (id === "custom" || (typeof t === "object" && t.path)) {
      const root = path.resolve(project.root, t.path);
      list.push({ id: "custom", label: `フォルダ（${root}）`, root: fs.existsSync(root) ? root : null, engine: t.version ? t.version.split(".").map(Number) : null, raw: t.version ?? null, kind: "custom" });
    } else {
      log.warn(`知らない送り先です: ${JSON.stringify(t)}（bedrock / preview / education / education-preview / bds のどれか）`);
    }
  }
  return list;
}

export function allGameTargets() {
  return Object.entries(PRODUCTS).map(([id, p]) => {
    const { root, engine, raw } = gameInfo(id);
    return { id, label: p.label, root, engine, raw, debug: p.debug, kind: "game" };
  });
}

export function packDestRoot(target, kind) {
  return path.join(target.root, DEV_DIRS[kind]);
}

// BDS は、ワールドの world_*_packs.json に載っていないと読み込まれない
export function registerPacksOnBds(target, packs) {
  if (target.kind !== "bds" || !target.world) return;
  const worldDir = path.join(target.root, "worlds", target.world);
  if (!fs.existsSync(worldDir)) {
    log.warn(`BDS のワールドが見つかりません: ${worldDir}（addon.config.json の bds.world を確認）`);
    return;
  }
  for (const kind of ["bp", "rp"]) {
    const file = path.join(worldDir, kind === "bp" ? "world_behavior_packs.json" : "world_resource_packs.json");
    const list = fs.existsSync(file) ? readJson(file) : [];
    let changed = false;
    for (const p of packs.filter((x) => x.kind === kind)) {
      const uuid = p.manifest.header.uuid;
      const version = p.manifest.header.version;
      const hit = list.find((e) => e.pack_id === uuid);
      if (!hit) { list.push({ pack_id: uuid, version }); changed = true; }
      else if (JSON.stringify(hit.version) !== JSON.stringify(version)) { hit.version = version; changed = true; }
    }
    if (changed) {
      writeJsonKeepStyle(file, list);
      log.info(`BDS のワールド「${target.world}」に ${kind.toUpperCase()} を登録しました`);
    }
  }
}
