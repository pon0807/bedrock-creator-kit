// 検証（Mojang の Creator Tools）、版番号の更新、.mcaddon / .mcpack の作成、UUID の振り直し
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { zipSync } from "fflate";
import { log, color, runCapture, nodeBin, walk, readJson, writeJsonKeepStyle, hasJsonComments, bump, rmrf } from "./util.mjs";
import { build, stageDir } from "./build.mjs";
import { checkAll, uuidReport } from "./check.mjs";
import { loadProject, addonsOf, selectAddons, loosePacks } from "./project.mjs";
import { bakePack } from "./brarchive.mjs";

const TYPE_JA = { error: "エラー", testFail: "失敗", warning: "注意", recommendation: "おすすめ" };

export async function validate(project, { suite = "main", built = false } = {}) {
  if (!built) await build(project, { mode: "prod", deploy: false });
  const stage = stageDir(project, "prod");
  const outDir = path.join(project.root, ".bkit", "mct");
  log.step(`検証（Minecraft Creator Tools、${suite}）`);
  const args = [nodeBin("@minecraft/creator-tools/cli/index.mjs"), "validate", suite];
  const ex = project.config.validate?.exclude;
  if (ex?.length) args.push(ex.join(","));
  args.push("-i", stage, "--single", "--json", "-o", outDir);
  const r = runCapture(process.execPath, args, { cwd: project.root });
  const i = r.stdout.indexOf("{");
  let data;
  try {
    data = JSON.parse(r.stdout.slice(i));
  } catch {
    console.log((r.stdout + r.stderr).slice(0, 4000));
    log.error("検証の結果を読めませんでした");
    return { errors: 1 };
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(data, null, 2));
  const items = (data.projects ?? []).flatMap((p) => p.items ?? []);
  const ignore = new Set(project.config.validate?.ignore ?? []);
  const shown = items.filter((x) => ["error", "testFail", "warning"].includes(x.type) && !ignore.has(x.generatorId));
  // 同じ種類の指摘はまとめる
  const groups = new Map();
  for (const x of shown) {
    const k = `${x.type}|${x.generatorId}|${x.message}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const order = { error: 0, testFail: 1, warning: 2 };
  const sorted = [...groups.entries()].sort((a, b) => order[a[1][0].type] - order[b[1][0].type]);
  for (const [, list] of sorted) {
    const x = list[0];
    const tag = x.type === "warning" ? color.yellow(TYPE_JA[x.type]) : color.red(TYPE_JA[x.type]);
    console.log(`  ${tag} ${color.gray(x.generatorId)} ${x.message}${list.length > 1 ? color.gray(` ×${list.length}`) : ""}`);
    for (const y of list.slice(0, 3)) {
      const where = [y.path, y.data].filter(Boolean).join(" ");
      if (where) console.log(color.gray(`      ${String(where).slice(0, 160)}`));
    }
  }
  const errors = shown.filter((x) => x.type === "error" || x.type === "testFail").length;
  const warnings = shown.filter((x) => x.type === "warning").length;
  const recs = items.filter((x) => x.type === "recommendation").length;
  const msg = `検証: エラー ${errors} 件、注意 ${warnings} 件、おすすめ ${recs} 件（全文は .bkit/mct/report.json）`;
  (errors ? log.error : warnings ? log.warn : log.ok)(msg);
  return { errors, warnings };
}

// アドオン（パックの組）の版を上げる。ほかのアドオンからこのアドオンへの依存の版も合わせる
export function bumpAddon(project, addon, kind = "patch") {
  const own = new Set(addon.packs.map((p) => p.manifest.header.uuid));
  const next = bump(addon.packs[0]?.manifest.header.version ?? "1.0.0", kind);
  const shape = (v) => (Array.isArray(v) ? (Array.isArray(next) ? next : next.split(".").map(Number)) : Array.isArray(next) ? next.join(".") : next);
  for (const p of project.packs) {
    const mine = addon.packs.includes(p);
    const refs = (p.manifest.dependencies ?? []).some((d) => d.uuid && own.has(d.uuid));
    if (!mine && !refs) continue;
    const text = fs.readFileSync(p.manifestPath, "utf8");
    if (hasJsonComments(text)) {
      log.warn(`${p.name}/manifest.json にコメントがあるので、版は手で直してください → ${JSON.stringify(next)}`);
      continue;
    }
    const m = readJson(p.manifestPath);
    if (mine) {
      m.header.version = shape(m.header.version);
      for (const mod of m.modules ?? []) mod.version = shape(mod.version);
    }
    for (const d of m.dependencies ?? []) if (d.uuid && own.has(d.uuid)) d.version = shape(d.version);
    writeJsonKeepStyle(p.manifestPath, m);
  }
  return Array.isArray(next) ? next.join(".") : next;
}

// 全部を 1 つのアドオンとして上げる（前の版との互換）
export function bumpVersions(project, kind = "patch") {
  return bumpAddon(project, addonsOf(project)[0], kind);
}

function zipDir(dir, prefix = "") {
  const files = {};
  for (const f of walk(dir)) {
    if (f.endsWith(".map")) continue;
    const rel = path.relative(dir, f).split(path.sep).join("/");
    files[prefix + rel] = [fs.readFileSync(f), { level: 9 }];
  }
  return zipSync(files);
}

// brarchive にまとめるか。--brarchive / --no-brarchive が無ければ addon.config.json の release.brarchive
export const brarchiveDefault = (project) => project.config.release?.brarchive === true;

// パックを brarchive の形にした写しを .bkit/brarchive/ に作り、そのフォルダを返す（スキンパックはそのまま）
function brarchiveCopy(project, p, dir) {
  if (p.kind === "sp") return { dir };
  const out = path.join(project.root, ".bkit", "brarchive", p.name);
  rmrf(out);
  const stats = bakePack(dir, out, { skip: (rel) => rel.endsWith(".map") });
  return { dir: out, stats };
}

// 1 つのアドオンの .mcaddon と、パックごとの .mcpack
export function packageAddon(project, addon, version, { multi = false, brarchive = false } = {}) {
  const stage = stageDir(project, "prod");
  const dist = path.join(project.root, "dist");
  const base = multi ? `${project.name}_${addon.id}_v${version}` : `${project.name}_v${version}`;
  const packsDir = path.join(dist, base);
  rmrf(packsDir);
  fs.mkdirSync(packsDir, { recursive: true });
  const all = {};
  const baked = [];
  for (const p of addon.packs) {
    let dir = path.join(stage, p.dirName, p.name);
    if (brarchive) {
      const r = brarchiveCopy(project, p, dir);
      dir = r.dir;
      if (r.stats) baked.push({ pack: p.name, ...r.stats });
    }
    fs.writeFileSync(path.join(packsDir, `${p.name}.mcpack`), zipDir(dir));
    for (const f of walk(dir)) {
      if (f.endsWith(".map")) continue;
      all[`${p.name}/${path.relative(dir, f).split(path.sep).join("/")}`] = [fs.readFileSync(f), { level: 9 }];
    }
  }
  const file = path.join(dist, `${base}.mcaddon`);
  fs.writeFileSync(file, zipSync(all));
  return { addon: file, packsDir, baked };
}

const verOf = (addon) => {
  const v = addon.packs[0]?.manifest.header.version ?? "1.0.0";
  return Array.isArray(v) ? v.join(".") : v;
};

// 配布ファイルを作る。アドオンが複数あるプロジェクトでは、アドオンごとに別のファイル・別の版になる
export async function release(project, { kind = "patch", force = false, skipValidate = false, addons: spec, brarchive } = {}) {
  brarchive ??= brarchiveDefault(project);
  const all = addonsOf(project);
  const selected = selectAddons(project, spec);
  const multi = all.length > 1;
  log.step(`${color.bold(project.name)} の配布ファイルを作ります${multi ? `（${selected.map((a) => a.display).join("・")}）` : ""}`);
  for (const p of loosePacks(project)) log.warn(`${p.name} はどのアドオンにも入っていないので、配布ファイルには入りません（addon.config.json の addons）`);
  for (const a of selected) for (const n of a.missing ?? []) log.warn(`アドオン ${a.id} のパック ${n} が見つかりません`);
  const c = checkAll(project);
  if (c.errors && !force) {
    log.error("チェックで問題があるので止めました（それでも作るなら --force）");
    return 1;
  }
  const b = await build(project, { mode: "prod", deploy: false });
  if (!b.ok && !force) return 1;
  if (!skipValidate) {
    const v = await validate(project, { built: true });
    if (v.errors && !force) {
      log.error("検証でエラーがあるので止めました（それでも作るなら --force）");
      return 1;
    }
  }

  // 版を上げる（依存されている本体を先に上げると、拡張の依存の版も新しくなる）
  const versions = new Map();
  let fresh = project;
  const order = [...selected].sort((x, y) => (y.requires.includes(x.id) ? -1 : x.requires.includes(y.id) ? 1 : 0));
  for (const a of order) {
    const cur = addonsOf(fresh).find((x) => x.id === a.id);
    if (kind === "none") versions.set(a.id, verOf(cur));
    else {
      const v = bumpAddon(fresh, cur, kind);
      versions.set(a.id, v);
      log.ok(`${multi ? `${a.display}（${a.id}）の` : ""}版を ${v} にしました（${kind}）`);
      fresh = loadProject(project.root);
    }
  }
  if (!multi && kind !== "none") {
    const pj = path.join(project.root, "package.json");
    if (fs.existsSync(pj)) {
      const j = readJson(pj);
      j.version = versions.get(selected[0].id);
      writeJsonKeepStyle(pj, j);
    }
  }
  fresh = loadProject(project.root);
  await build(fresh, { mode: "prod", deploy: false });
  for (const a of order) {
    const cur = addonsOf(fresh).find((x) => x.id === a.id);
    const { addon, packsDir, baked } = packageAddon(fresh, cur, versions.get(a.id), { multi, brarchive });
    log.ok(`できました: ${path.relative(project.root, addon)}${brarchive ? "（brarchive の形）" : ""}`);
    for (const s of baked) {
      log.info(color.gray(`  ${s.pack}: archive ${s.archives} 個にまとめました（まとめたファイル ${s.packed}、ばらのファイル ${s.loose}）`));
      for (const f of s.unreadable) log.warn(`${s.pack}/${f} は JSON として読めないので、まとめずにそのまま入れました（末尾のカンマなど）`);
    }
    log.info(color.gray(`パック単体の .mcpack: ${path.relative(project.root, packsDir)}`));
    for (const rid of cur.requires) log.info(color.gray(`  ${cur.display} を使うには ${addonsOf(fresh).find((x) => x.id === rid)?.display ?? rid} も入れる必要があります`));
  }
  log.info(color.gray("配布物では `dev:` ラベルの付いた文と debugger 文を消しています"));
  return 0;
}

// プロジェクトの UUID を振り直す（header と modules。中のパック同士の依存も直す）
export function reassignUuids(project, { only } = {}) {
  const map = new Map();
  const packs = only ? project.packs.filter((p) => only.includes(p.name)) : project.packs;
  for (const p of packs) {
    map.set(p.manifest.header.uuid, crypto.randomUUID());
    for (const mod of p.manifest.modules ?? []) map.set(mod.uuid, crypto.randomUUID());
  }
  for (const p of project.packs) {
    const m = readJson(p.manifestPath);
    let changed = false;
    if (map.has(m.header.uuid)) { m.header.uuid = map.get(m.header.uuid); changed = true; }
    for (const mod of m.modules ?? []) if (map.has(mod.uuid)) { mod.uuid = map.get(mod.uuid); changed = true; }
    for (const d of m.dependencies ?? []) if (d.uuid && map.has(d.uuid)) { d.uuid = map.get(d.uuid); changed = true; }
    if (changed) {
      writeJsonKeepStyle(p.manifestPath, m);
      log.ok(`${p.name}: UUID を振り直しました`);
    }
  }
  return map;
}

export async function uuidCommand(project, args) {
  if (args.fix) {
    const { dups } = uuidReport(project);
    if (!dups.length) return 0;
    const names = new Set();
    for (const [, v] of dups) for (const x of v) if (x.file.startsWith(project.root + path.sep)) names.add(path.basename(path.dirname(x.file)));
    reassignUuids(project, { only: [...names] });
    log.info("ワールドに入れてあるなら、ワールドの設定でパックを入れ直してください（UUID が変わると別のパック扱い）");
    return 0;
  }
  if (args.new) {
    for (let i = 0; i < Number(args.new === true ? 1 : args.new); i++) console.log(crypto.randomUUID());
    return 0;
  }
  return uuidReport(project).errors ? 1 : 0;
}
