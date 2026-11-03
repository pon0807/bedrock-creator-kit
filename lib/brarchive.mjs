// パックを .brarchive（Mojang の公式パックと同じ __brarchive\ の形）にまとめる
//
// 形式: bedrock-crustaceans/brarchive の FORMAT.md（version 1）。ヘッダ 16 バイト（識別子・件数・版）、
// 1 件ごとに 256 バイトの記述（名前の長さ・名前・位置・長さ）、そのあとに中身。すべてリトルエンディアン。
//
// どのファイルをまとめ、どれをばらで残すかは、Windows 版 BDS 1.26.61 の PackOptimizer
// （bedrock_server.exe PackOptimizerConfigPath=...）の出力に合わせた（2026-11-03 に確かめた）。
//   - パックの直下のファイル（manifest.json、pack_icon.png など）はまとめない
//   - フォルダ 1 つにつき archive 1 つ（textures\blocks\ → __brarchive\textures\blocks.brarchive）。中のサブフォルダは別の archive
//   - 中身のあるフォルダだけ（空のフォルダは作らない）
//   - JSON は空白とコメントを抜いて入れる。png・tga・js・mcfunction はそのまま入れる
//   - それ以外（lang、ogg、mcstructure など）と、読めない JSON は、ばらで残し、archive には長さ 0 の項目だけを入れる
//   - 一部の JSON は、まとめたうえで、ばらでも残す（KEEP_LOOSE_NAMES、KEEP_LOOSE_DIRS）
//   - subpacks\ の中は、サブパックごとに別のパックとして扱う
//   - manifest.json の header に pack_optimization_version を足す
// Mojang と違うところ: 数や文字列の書き方を変えない（Mojang は 1.50 → 1.5 と書き直し、
// "é" を壊し、"\\" を "\" にしてしまう）。空白とコメントを抜くだけなので、意味は変わらない。
import fs from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from([0x7d, 0x27, 0x25, 0xb1, 0xa0, 0x52, 0x70, 0x26]);
const HEADER = 16;
const DESC = 256;
const NAME_MAX = 247;

export const ARCHIVE_DIR = "__brarchive";
export const OPTIMIZATION_VERSION = "0.1.0";
const PACK_AS_IS = new Set([".png", ".tga", ".js", ".mcfunction"]);
const KEEP_LOOSE_NAMES = new Set([
  "biomes_client.json",
  "blocks.json",
  "contents.json",
  "flipbook_textures.json",
  "languages.json",
  "sounds.json",
  "splashes.json",
  "terrain_texture.json",
]);
const KEEP_LOOSE_DIRS = new Set(["loot_tables", "materials"]);

// entries: [{ name, data: Buffer }]
export function encodeArchive(entries) {
  const names = entries.map((e) => {
    const b = Buffer.from(e.name, "utf8");
    if (b.length > NAME_MAX) throw new Error(`ファイル名が長すぎます（${NAME_MAX} バイトまで）: ${e.name}`);
    return b;
  });
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  const base = HEADER + entries.length * DESC;
  const out = Buffer.alloc(base + total);
  MAGIC.copy(out, 0);
  out.writeUInt32LE(entries.length, 8);
  out.writeUInt32LE(1, 12);
  let off = 0;
  entries.forEach((e, i) => {
    const p = HEADER + i * DESC;
    out[p] = names[i].length;
    names[i].copy(out, p + 1);
    out.writeUInt32LE(e.data.length ? off : 0, p + 248);
    out.writeUInt32LE(e.data.length, p + 252);
    e.data.copy(out, base + off);
    off += e.data.length;
  });
  return out;
}

export function decodeArchive(buf) {
  if (buf.length < HEADER || !buf.subarray(0, 8).equals(MAGIC)) throw new Error(".brarchive ではありません");
  const count = buf.readUInt32LE(8);
  const version = buf.readUInt32LE(12);
  if (version !== 1) throw new Error(`未対応の版です（version ${version}）`);
  const base = HEADER + count * DESC;
  if (base > buf.length) throw new Error(".brarchive が壊れています");
  const entries = [];
  for (let i = 0; i < count; i++) {
    const p = HEADER + i * DESC;
    const name = buf.subarray(p + 1, p + 1 + buf[p]).toString("utf8");
    const off = buf.readUInt32LE(p + 248);
    const len = buf.readUInt32LE(p + 252);
    if (base + off + len > buf.length) throw new Error(`.brarchive が壊れています（${name}）`);
    entries.push({ name, data: Buffer.from(buf.subarray(base + off, base + off + len)) });
  }
  return entries;
}

// JSON の空白とコメントを抜く。数・文字列は書かれたまま残す。
// コメント（// と /* */）と先頭の BOM は許す。末尾のカンマ、NaN、' の文字列、値が 2 つ以上などは読めないとして null を返す
export function minifyJson(input) {
  let s = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let i = 0;
  const out = [];
  const fail = () => {
    throw new SyntaxError("bad json");
  };
  const skip = () => {
    for (;;) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && s[i + 1] === "/") {
        while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
      } else if (c === "/" && s[i + 1] === "*") {
        const end = s.indexOf("*/", i + 2);
        if (end < 0) fail();
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const start = i++;
    for (;;) {
      if (i >= s.length) fail();
      const c = s.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) fail();
      if (c === 0x5c) {
        const e = s[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) fail();
          i += 6;
        } else if ('"\\/bfnrt'.includes(e) && e) i += 2;
        else fail();
      } else i++;
    }
    i++;
    out.push(s.slice(start, i));
  };
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = () => {
    skip();
    const c = s[i];
    if (c === "{") {
      out.push("{");
      i++;
      skip();
      if (s[i] === "}") {
        out.push("}");
        i++;
        return;
      }
      for (;;) {
        skip();
        if (s[i] !== '"') fail();
        string();
        skip();
        if (s[i] !== ":") fail();
        out.push(":");
        i++;
        value();
        skip();
        if (s[i] === ",") {
          out.push(",");
          i++;
        } else if (s[i] === "}") {
          out.push("}");
          i++;
          return;
        } else fail();
      }
    }
    if (c === "[") {
      out.push("[");
      i++;
      skip();
      if (s[i] === "]") {
        out.push("]");
        i++;
        return;
      }
      for (;;) {
        value();
        skip();
        if (s[i] === ",") {
          out.push(",");
          i++;
        } else if (s[i] === "]") {
          out.push("]");
          i++;
          return;
        } else fail();
      }
    }
    if (c === '"') return string();
    for (const w of ["true", "false", "null"]) {
      if (s.startsWith(w, i)) {
        out.push(w);
        i += w.length;
        return;
      }
    }
    NUM.lastIndex = i;
    const m = NUM.exec(s);
    if (!m || !m[0]) fail();
    out.push(m[0]);
    i += m[0].length;
  };
  try {
    value();
    skip();
    if (i !== s.length) fail();
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  return out.join("");
}

// manifest.json に pack_optimization_version を足す（空白とコメントは抜く）
function optimizedManifest(buf) {
  const min = minifyJson(buf);
  if (min == null) return null;
  const m = JSON.parse(min);
  if (!m?.header || typeof m.header !== "object") return null;
  m.header.pack_optimization_version = OPTIMIZATION_VERSION;
  return Buffer.from(JSON.stringify(m));
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // 文字コードの順（Mojang と同じ）
const listDir = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));

function hasFiles(dir, rel, skip) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && !skip(`${rel}/${e.name}`)) return true;
    if (e.isDirectory() && hasFiles(path.join(dir, e.name), `${rel}/${e.name}`, skip)) return true;
  }
  return false;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

// src のパックを brarchive の形にして dst に書く。skip(相対パス) が true のファイルは入れない（ソースマップなど）
// 戻り値: { archives, packed, loose, unreadable: [相対パス...] }
export function bakePack(src, dst, { skip = () => false } = {}) {
  const stats = { archives: 0, packed: 0, loose: 0, unreadable: [] };
  bakeRoot(src, dst, "", skip, stats);
  return stats;
}

function bakeRoot(src, dst, prefix, skip, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of listDir(src)) {
    const rel = prefix + e.name;
    if (e.isFile()) {
      if (skip(rel)) continue;
      let data = fs.readFileSync(path.join(src, e.name));
      if (e.name === "manifest.json") {
        const m = optimizedManifest(data);
        if (!m) throw new Error(`${rel} を読めません`);
        data = m;
      }
      write(path.join(dst, e.name), data);
      stats.loose++;
    }
  }
  for (const e of listDir(src)) {
    if (!e.isDirectory() || e.name === ARCHIVE_DIR) continue;
    if (e.name === "subpacks") {
      const sp = path.join(src, e.name);
      for (const x of listDir(sp)) {
        const rel = `${prefix}subpacks/${x.name}`;
        if (x.isDirectory()) bakeRoot(path.join(sp, x.name), path.join(dst, "subpacks", x.name), rel + "/", skip, stats);
        else if (!skip(rel)) {
          write(path.join(dst, "subpacks", x.name), fs.readFileSync(path.join(sp, x.name)));
          stats.loose++;
        }
      }
      continue;
    }
    bakeFolder(src, dst, e.name, prefix, skip, stats);
  }
}

// rel はパックの中の相対パス（区切りは /）
function bakeFolder(root, dst, rel, prefix, skip, stats) {
  const abs = path.join(root, rel);
  if (!hasFiles(abs, prefix + rel, skip)) return;
  const top = rel.split("/")[0];
  const entries = [];
  const ents = listDir(abs);
  for (const e of ents) {
    if (!e.isFile()) continue;
    const fileRel = `${rel}/${e.name}`;
    if (skip(prefix + fileRel)) continue;
    const data = fs.readFileSync(path.join(abs, e.name));
    const ext = path.extname(e.name).toLowerCase();
    const loose = (b) => {
      write(path.join(dst, ...fileRel.split("/")), b);
      stats.loose++;
    };
    if (PACK_AS_IS.has(ext)) {
      entries.push({ name: e.name, data });
      stats.packed++;
    } else if (ext === ".json") {
      const min = minifyJson(data);
      if (min == null) {
        entries.push({ name: e.name, data: Buffer.alloc(0) });
        loose(data);
        stats.unreadable.push(prefix + fileRel);
        continue;
      }
      const b = Buffer.from(min, "utf8");
      entries.push({ name: e.name, data: b });
      stats.packed++;
      if (KEEP_LOOSE_NAMES.has(e.name) || KEEP_LOOSE_DIRS.has(top)) loose(b);
    } else {
      entries.push({ name: e.name, data: Buffer.alloc(0) });
      loose(data);
    }
  }
  write(path.join(dst, ARCHIVE_DIR, ...`${rel}.brarchive`.split("/")), encodeArchive(entries));
  stats.archives++;
  for (const e of ents) if (e.isDirectory()) bakeFolder(root, dst, `${rel}/${e.name}`, prefix, skip, stats);
}
