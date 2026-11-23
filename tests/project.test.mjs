// 新しく作る（bkit new）・足す（bkit add）・組み立てて送る・配布ファイル・UUID の重複
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupEnv, quiet, readJson } from "./helpers.mjs";

const env = setupEnv();
// esbuild は裏で補助のプロセスを動かしていて、一時フォルダを開いたままにするので、止めてから片付ける
after(async () => {
  await (await import("esbuild")).stop();
  env.cleanup();
});
const { createProject, addAddon } = await import("../lib/scaffold.mjs");
const { loadProject, addonsOf } = await import("../lib/project.mjs");
const { build, MARK_FILE } = await import("../lib/build.mjs");
const { bumpAddon, packageAddon } = await import("../lib/release.mjs");
const { scanUuids } = await import("../lib/check.mjs");
const { unzipSync } = await import("fflate");
const { rmrf } = await import("../lib/util.mjs");

const root = path.join(env.ws, "stable", "Sword");
const bp = (n = "main") => path.join(root, "behavior_packs", `Sword_${n}BP`);
const rp = (n = "main") => path.join(root, "resource_packs", `Sword_${n}RP`);
const sp = (n = "main") => path.join(root, "skin_packs", `Sword_${n}SP`);

test("bkit new: BP・RP・スキンパックを、決まった形で作る", async () => {
  const done = quiet();
  const code = await createProject({ _: ["Sword"], display: "剣", targets: "bedrock,education", packs: "bp,rp,sp", modules: "server,ui,math", install: false, git: false });
  done();
  assert.equal(code, 0);

  const bm = readJson(path.join(bp(), "manifest.json"));
  assert.equal(bm.format_version, 3);
  assert.equal(bm.header.version, "1.0.0");
  assert.equal(bm.header.min_engine_version, "1.26.30", "一番古い送り先（教育版 1.26.32）に合わせる");
  assert.deepEqual(bm.metadata.authors, ["テスト作者"]);
  assert.deepEqual(bm.dependencies.find((d) => d.module_name === "@minecraft/server"), { module_name: "@minecraft/server", version: "2.8.0" });
  assert.deepEqual(bm.dependencies.find((d) => d.module_name === "@minecraft/server-ui"), { module_name: "@minecraft/server-ui", version: "2.1.0" });
  assert.ok(!bm.dependencies.some((d) => d.module_name === "@minecraft/math"), "ライブラリは manifest に書かない");

  const rm = readJson(path.join(rp(), "manifest.json"));
  assert.equal(rm.format_version, 3);
  assert.ok(bm.dependencies.some((d) => d.uuid === rm.header.uuid), "BP は同じアドオンの RP に依存する");

  const sm = readJson(path.join(sp(), "manifest.json"));
  assert.equal(sm.format_version, 1, "スキンパックは format_version 1");
  assert.match(readJson(path.join(sp(), "skins.json")).skins[0].localization_name, /_custom$/);

  // UUID はすべて違う
  const uuids = [bm, rm, sm].flatMap((m) => [m.header.uuid, ...m.modules.map((x) => x.uuid)]);
  assert.equal(new Set(uuids).size, uuids.length);

  assert.equal(fs.readFileSync(path.join(bp(), "scripts", "main.ts"), "utf8").trim(), "console.log('Addon Loaded!')");
  assert.match(fs.readFileSync(path.join(bp(), "texts", "ja_JP.lang"), "utf8"), /^pack\.name=剣\[BP\]$/m);
  assert.match(fs.readFileSync(path.join(rp(), "texts", "ja_JP.lang"), "utf8"), /^pack\.name=剣\[RP\]$/m);

  const pkg = readJson(path.join(root, "package.json"));
  assert.equal(pkg.dependencies["@minecraft/server"], "2.8.0", "型は manifest と同じ版");
  assert.ok(!pkg.devDependencies["bedrock-kit"]);
  const cfg = readJson(path.join(root, "addon.config.json"));
  assert.deepEqual(cfg.addons[0].packs, ["Sword_mainBP", "Sword_mainRP", "Sword_mainSP"]);
  assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")), "Claude を使わない人には CLAUDE.md を作らない（ふだん）");
  assert.ok(fs.existsSync(path.join(root, "README.md")));
});

test("bkit new: CLAUDE.md は --claude-md か、設定で「使う」にした人だけ作る", async () => {
  const where = path.join(env.tmp, "claude-md");
  const make = async (name, extra) => {
    const done = quiet();
    const code = await createProject({ _: name ? [name] : [], dir: where, targets: "bedrock", packs: "bp", modules: "server", install: false, git: false, ...extra });
    done();
    assert.equal(code, 0);
  };
  const has = (n) => fs.existsSync(path.join(where, n, "CLAUDE.md"));

  await make("WithFlag", { "claude-md": true });
  assert.ok(has("WithFlag"));
  assert.match(fs.readFileSync(path.join(where, "WithFlag", "CLAUDE.md"), "utf8"), /<!-- bkit -->/);
  // 「bkit new --claude-md 名前」と書いても、名前として読む
  await make(null, { "claude-md": "FlagFirst" });
  assert.ok(has("FlagFirst"));

  // 設定で「使う」にした PC では、言わなくても作る。--no-claude-md なら作らない
  const settings = process.env.BKIT_SETTINGS;
  const before = fs.readFileSync(settings, "utf8");
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(before), claudeMd: true }));
  try {
    await make("BySetting");
    assert.ok(has("BySetting"));
    await make("Opted", { "claude-md": false });
    assert.ok(!has("Opted"));
  } finally {
    fs.writeFileSync(settings, before);
  }
});

test("bkit add: 追加コンテンツを足すと、本体への依存が manifest に入る", async () => {
  const done = quiet();
  const code = await addAddon(loadProject(root), { _: ["extra"], display: "追加", packs: "bp,rp", requires: "main", modules: "server@2.8.0", install: false });
  done();
  assert.equal(code, 0);
  const main = readJson(path.join(bp(), "manifest.json"));
  const extra = readJson(path.join(bp("extra"), "manifest.json"));
  assert.ok(extra.dependencies.some((d) => d.uuid === main.header.uuid), "本体の BP に依存");
  const cfg = readJson(path.join(root, "addon.config.json"));
  assert.deepEqual(cfg.addons.map((a) => a.id), ["main", "extra"]);
  assert.deepEqual(cfg.addons[1].requires, ["main"]);
  assert.equal(addonsOf(loadProject(root)).length, 2);
});

test("組み立てて送る: 目印を置き、.map は送らない", async () => {
  const done = quiet();
  const r = await build(loadProject(root), { mode: "dev", deploy: true, only: "bedrock" });
  done();
  assert.ok(r.ok);
  const dest = path.join(env.gamesRoot, "bedrock", "development_behavior_packs", "Sword_mainBP");
  assert.ok(fs.existsSync(path.join(dest, "scripts", "main.js")));
  assert.ok(!fs.existsSync(path.join(dest, "scripts", "main.js.map")));
  assert.ok(!fs.existsSync(path.join(dest, "scripts", "main.ts")));
  assert.equal(readJson(path.join(dest, MARK_FILE)).uuid, readJson(path.join(bp(), "manifest.json")).header.uuid);
  assert.ok(fs.existsSync(path.join(env.gamesRoot, "bedrock", "development_skin_packs", "Sword_mainSP", "skins.json")));
});

test("送り先に同じ名前の別のパックがあれば、消さずに止める", async () => {
  const dest = path.join(env.gamesRoot, "education", "development_resource_packs", "Sword_mainRP");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "ほかの人のパック", uuid: "11111111-1111-1111-1111-111111111111", version: [1, 0, 0] } }));
  fs.writeFileSync(path.join(dest, "大事なファイル.txt"), "消えてはいけない");
  const done = quiet();
  const r = await build(loadProject(root), { mode: "dev", deploy: true, only: "education" });
  done();
  assert.equal(r.ok, false, "送れなかったことを返す");
  assert.ok(fs.existsSync(path.join(dest, "大事なファイル.txt")), "ほかのパックのファイルは残る");
  assert.ok(!fs.existsSync(path.join(dest, MARK_FILE)));
  // ほかのパックは送れている
  assert.ok(fs.existsSync(path.join(env.gamesRoot, "education", "development_behavior_packs", "Sword_mainBP", "manifest.json")));
});

test("目印がなくても、同じ UUID の古い写しなら入れ直す", async () => {
  const uuid = readJson(path.join(rp("extra"), "manifest.json")).header.uuid;
  const dest = path.join(env.gamesRoot, "bedrock", "development_resource_packs", "Sword_extraRP");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({ header: { uuid, version: "0.9.0" } }));
  fs.writeFileSync(path.join(dest, "古いファイル.json"), "{}");
  const done = quiet();
  const r = await build(loadProject(root), { mode: "dev", deploy: true, only: "bedrock" });
  done();
  assert.ok(r.ok);
  assert.ok(!fs.existsSync(path.join(dest, "古いファイル.json")), "古い写しは入れ直される");
  assert.ok(fs.existsSync(path.join(dest, MARK_FILE)));
});

test("送るときは、送り先のフォルダそのものは消さずに、前の版の残りだけ消す（ゲームが開いていても送れるように）", async () => {
  const dest = path.join(env.gamesRoot, "bedrock", "development_behavior_packs", "Sword_mainBP");
  const done = quiet();
  await build(loadProject(root), { mode: "dev", deploy: true, only: "bedrock" });
  const ino = fs.statSync(dest).ino;
  fs.mkdirSync(path.join(dest, "old_dir", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dest, "old_dir", "deep", "残り.json"), "{}");
  fs.writeFileSync(path.join(dest, "残り.txt"), "x");
  const r = await build(loadProject(root), { mode: "dev", deploy: true, only: "bedrock" });
  done();
  assert.ok(r.ok);
  assert.equal(fs.statSync(dest).ino, ino, "フォルダは作り直さない");
  assert.ok(!fs.existsSync(path.join(dest, "残り.txt")));
  assert.ok(!fs.existsSync(path.join(dest, "old_dir")), "空になったフォルダは消す");
  assert.ok(fs.existsSync(path.join(dest, "scripts", "main.js")));
  assert.ok(fs.existsSync(path.join(dest, "manifest.json")));
  assert.ok(fs.existsSync(path.join(dest, MARK_FILE)));
});

test("rmrf: 日本語の名前のファイル 1 つを消しても落ちない", () => {
  const dir = fs.mkdtempSync(path.join(env.gamesRoot, "rmrf-"));
  const f = path.join(dir, "日本語のファイル.json");
  fs.writeFileSync(f, "{}");
  rmrf(f);
  assert.ok(!fs.existsSync(f));
  rmrf(f); // 無くても止まらない
  rmrf(dir);
  assert.ok(!fs.existsSync(dir));
});

test("配布: アドオンごとに版を上げ、拡張の依存の版も合わせる。zip にはそのアドオンのパックだけ", async () => {
  const project = loadProject(root);
  const done = quiet();
  await build(project, { mode: "prod", deploy: false });
  const v = bumpAddon(project, addonsOf(project).find((a) => a.id === "main"), "minor");
  done();
  assert.equal(v, "1.1.0");
  const fresh = loadProject(root);
  assert.equal(readJson(path.join(bp(), "manifest.json")).header.version, "1.1.0");
  assert.deepEqual(readJson(path.join(sp(), "manifest.json")).header.version, [1, 1, 0], "スキンパックは配列のまま");
  assert.equal(readJson(path.join(bp("extra"), "manifest.json")).header.version, "1.0.0", "拡張の版は変えない");
  const mainUuid = readJson(path.join(bp(), "manifest.json")).header.uuid;
  assert.equal(readJson(path.join(bp("extra"), "manifest.json")).dependencies.find((d) => d.uuid === mainUuid).version, "1.1.0", "拡張の依存の版は合わせる");

  const done2 = quiet();
  await build(fresh, { mode: "prod", deploy: false });
  const { addon } = packageAddon(fresh, addonsOf(fresh).find((a) => a.id === "extra"), "1.0.0", { multi: true });
  done2();
  assert.match(path.basename(addon), /^Sword_extra_v1\.0\.0\.mcaddon$/);
  const tops = new Set(Object.keys(unzipSync(fs.readFileSync(addon))).map((k) => k.split("/")[0]));
  assert.deepEqual([...tops].sort(), ["Sword_extraBP", "Sword_extraRP"]);

  // brarchive の形: BP・RP は __brarchive にまとめ、スキンパックはそのまま。ソースマップは入れない
  const done3 = quiet();
  const br = packageAddon(fresh, addonsOf(fresh).find((a) => a.id === "main"), "1.1.0", { multi: true, brarchive: true });
  done3();
  const names = Object.keys(unzipSync(fs.readFileSync(br.addon)));
  assert.ok(names.includes("Sword_mainBP/__brarchive/scripts.brarchive"), names.join("\n"));
  assert.ok(!names.some((n) => n.startsWith("Sword_mainBP/scripts/")), "スクリプトは archive の中だけ");
  assert.ok(!names.some((n) => n.endsWith(".map")));
  assert.ok(names.includes("Sword_mainRP/__brarchive/texts.brarchive"));
  assert.ok(!names.some((n) => n.startsWith("Sword_skins/__brarchive")), "スキンパックはまとめない");
  const files = unzipSync(fs.readFileSync(br.addon));
  assert.equal(JSON.parse(Buffer.from(files["Sword_mainBP/manifest.json"]).toString()).header.pack_optimization_version, "0.1.0");
  assert.deepEqual(br.baked.map((b) => b.pack).sort(), ["Sword_mainBP", "Sword_mainRP"]);
});

test("配布の形式: 選んだ形式だけを作る（mcaddon / mcpack / zip）", async () => {
  const fresh = loadProject(root);
  const extra = addonsOf(fresh).find((a) => a.id === "extra");
  const dist = path.join(root, "dist");
  const done = quiet();
  await build(fresh, { mode: "prod", deploy: false });
  rmrf(dist);

  // 何も言わなければ .mcaddon だけ（パックごとの .mcpack は作らない）
  const a = packageAddon(fresh, extra, "2.0.0", { multi: true });
  assert.deepEqual(a.formats, ["mcaddon"]);
  assert.deepEqual(fs.readdirSync(dist), ["Sword_extra_v2.0.0.mcaddon"]);
  assert.equal(a.packsDir, null);

  // .mcpack だけ: パックごとに 1 つずつ。中はパックの中身がそのまま（manifest.json が一番上）
  rmrf(dist);
  const b = packageAddon(fresh, extra, "2.0.0", { multi: true, formats: "mcpack" });
  assert.equal(b.addon, null);
  assert.deepEqual(fs.readdirSync(dist), ["Sword_extra_v2.0.0"]);
  assert.deepEqual(fs.readdirSync(b.packsDir).sort(), ["Sword_extraBP.mcpack", "Sword_extraRP.mcpack"]);
  assert.ok(Object.keys(unzipSync(fs.readFileSync(path.join(b.packsDir, "Sword_extraBP.mcpack")))).includes("manifest.json"));

  // .zip: 中身は .mcaddon と同じ。並べると両方
  rmrf(dist);
  const c = packageAddon(fresh, extra, "2.0.0", { multi: true, formats: "zip,mcaddon" });
  done();
  assert.deepEqual(c.formats, ["mcaddon", "zip"]);
  assert.deepEqual(fs.readdirSync(dist).sort(), ["Sword_extra_v2.0.0.mcaddon", "Sword_extra_v2.0.0.zip"]);
  const names = (f) => Object.keys(unzipSync(fs.readFileSync(path.join(dist, f)))).sort();
  assert.deepEqual(names("Sword_extra_v2.0.0.zip"), names("Sword_extra_v2.0.0.mcaddon"));
  rmrf(dist);
});

test("配布の形式: 書き方と、addon.config.json の release.format", async () => {
  const { parseFormats, formatDefault } = await import("../lib/release.mjs");
  assert.deepEqual(parseFormats("mcpack"), ["mcpack"]);
  assert.deepEqual(parseFormats(" ZIP , .mcaddon "), ["mcaddon", "zip"], "大文字・空白・点は気にしない。順は決まった順");
  assert.deepEqual(parseFormats(["zip"]), ["zip"]);
  assert.throws(() => parseFormats("mcworld"), /知らない形式/);
  assert.throws(() => parseFormats(""), /1 つ以上/);
  assert.deepEqual(formatDefault({ config: {} }), ["mcaddon"]);
  assert.deepEqual(formatDefault({ config: { release: { format: "zip" } } }), ["zip"]);
  assert.deepEqual(formatDefault({ config: { release: { format: ["mcpack", "zip"] } } }), ["mcpack", "zip"]);
});

test("UUID の重複を見つける（同じ名前のフォルダ＝写しは数えない、BDS 一式は見ない）", () => {
  const other = path.join(env.ws, "stable", "Other", "behavior_packs", "Other_mainBP");
  fs.mkdirSync(other, { recursive: true });
  const dupUuid = readJson(path.join(bp(), "manifest.json")).header.uuid;
  fs.writeFileSync(path.join(other, "manifest.json"), JSON.stringify({ header: { uuid: dupUuid }, modules: [] }));
  // 同じパックの写し（フォルダ名が同じ）
  const copy = path.join(env.ws, "stable", "Sword", "old", "Sword_mainBP");
  fs.mkdirSync(copy, { recursive: true });
  fs.copyFileSync(path.join(bp(), "manifest.json"), path.join(copy, "manifest.json"));
  // BDS 一式の中のバニラ
  const bds = path.join(env.ws, "stable", "Sword", "server");
  fs.mkdirSync(path.join(bds, "behavior_packs", "vanilla"), { recursive: true });
  fs.writeFileSync(path.join(bds, "bedrock_server.exe"), "");
  fs.writeFileSync(path.join(bds, "behavior_packs", "vanilla", "manifest.json"), JSON.stringify({ header: { uuid: dupUuid } }));

  const dups = scanUuids();
  const hit = dups.find(([u]) => u === dupUuid.toLowerCase());
  assert.ok(hit, "別のプロジェクトとの重複を見つける");
  assert.ok(hit[1].every((x) => !x.file.includes(`${path.sep}server${path.sep}`)), "BDS 一式は見ない");
});
