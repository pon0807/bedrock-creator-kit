// 共通の小物（ログ、JSON、ファイル操作、版番号）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


// ---------- ログ ----------
const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { red: c(31), green: c(32), yellow: c(33), blue: c(34), gray: c(90), bold: c(1), cyan: c(36) };
const now = () => new Date().toTimeString().slice(0, 8);
export const log = {
  step: (msg) => console.log(`${color.gray(now())} ${color.cyan("■")} ${msg}`),
  info: (msg) => console.log(`${color.gray(now())}   ${msg}`),
  ok: (msg) => console.log(`${color.gray(now())} ${color.green("✔")} ${msg}`),
  warn: (msg) => console.log(`${color.gray(now())} ${color.yellow("⚠")} ${msg}`),
  error: (msg) => console.log(`${color.gray(now())} ${color.red("✖")} ${msg}`),
};

// ---------- JSON ----------
// manifest などにコメントや末尾カンマがあっても読めるようにする
export function parseJsonLoose(text, file = "") {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (inStr) {
        out += ch;
        if (ch === "\\") { out += next; i++; }
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; out += ch; continue; }
      if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
      if (ch === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
      out += ch;
    }
    out = out.replace(/^﻿/, "").replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(out);
    } catch (e) {
      throw new Error(`JSON を読めません: ${file}\n  ${e.message}`);
    }
  }
}

export function readJson(file) {
  return parseJsonLoose(fs.readFileSync(file, "utf8"), file);
}

export function hasJsonComments(text) {
  return /(^|[^:"])\/\/|\/\*/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
}

// 元のインデント（タブ / スペース）を保って書き戻す
export function writeJsonKeepStyle(file, data) {
  let indent = "  ";
  if (fs.existsSync(file)) {
    const m = fs.readFileSync(file, "utf8").match(/\n([ \t]+)"/);
    if (m) indent = m[1];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, indent) + "\n");
}

export function writeJson(file, data, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, indent) + "\n");
}

// ---------- ファイル ----------
export function walk(dir, { skip = () => false } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const rec = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (skip(full, ent)) continue;
      if (ent.isDirectory()) rec(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  rec(dir);
  return out;
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

// 中身が同じならコピーしない（Minecraft の再読み込みを減らす）
export function copyIfChanged(src, dest) {
  const buf = fs.readFileSync(src);
  if (fs.existsSync(dest)) {
    const old = fs.readFileSync(dest);
    if (old.equals(buf)) return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return true;
}

export const toPosix = (p) => p.split(path.sep).join("/");

// 簡易グロブ（** と * と ?）→ 正規表現
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if ("\\^$+.()|{}[]".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp("^" + re + "$", "i");
}

// ---------- 外部コマンド ----------
// shell を使うときは 1 本の文字列にして渡す（Node の DEP0190 を避ける）
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function spawnArgs(cmd, args, opts) {
  return opts.shell ? [[cmd, ...args.map(quote)].join(" "), []] : [cmd, args];
}

export function run(cmd, args, opts = {}) {
  const [c, a] = spawnArgs(cmd, args, opts);
  const r = spawnSync(c, a, { stdio: "inherit", shell: false, ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

export function runCapture(cmd, args, opts = {}) {
  const [c, a] = spawnArgs(cmd, args, opts);
  const r = spawnSync(c, a, { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

// 道具が使うパッケージの中のファイル。道具の node_modules か、上の階層（ワークスペースに入れたとき）を探す
export function nodeBin(rel) {
  const parts = rel.split("/");
  const pkg = rel.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const rest = parts.slice(pkg.split("/").length);
  let d = KIT_ROOT;
  for (;;) {
    const cand = path.join(d, "node_modules", ...pkg.split("/"));
    if (fs.existsSync(cand)) return path.join(cand, ...rest);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.join(KIT_ROOT, "node_modules", rel);
}

// ---------- 版番号 ----------
// "1.26.40" / [1,26,40] / "2.9.0-beta" を扱う
export function parseVersion(v) {
  if (Array.isArray(v)) return { nums: v.map(Number), pre: "" };
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
}

export function cmpNums(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const verStr = (nums) => nums.join(".");

export function bump(v, kind) {
  const p = parseVersion(v);
  const [a, b, c2] = p.nums;
  const next = kind === "major" ? [a + 1, 0, 0] : kind === "minor" ? [a, b + 1, 0] : [a, b, c2 + 1];
  return Array.isArray(v) ? next : verStr(next);
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) args[k] = v;
      else if (k.startsWith("no-")) args[k.slice(3)] = false;
      else if (argv[i + 1] && !argv[i + 1].startsWith("-")) args[k] = argv[++i];
      else args[k] = true;
    } else if (a.startsWith("-") && a.length === 2) {
      args[a.slice(1)] = true;
    } else args._.push(a);
  }
  return args;
}
