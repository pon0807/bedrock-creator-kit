import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { encodeArchive, decodeArchive, minifyJson, bakePack, OPTIMIZATION_VERSION } from "../lib/brarchive.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bkit-br-"));
}
function put(root, rel, data) {
  const f = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}
function walk(d, b = d) {
  let r = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) r = r.concat(walk(p, b));
    else r.push(path.relative(b, p).split(path.sep).join("/"));
  }
  return r.sort();
}
const archive = (root, rel) => decodeArchive(fs.readFileSync(path.join(root, "__brarchive", ...`${rel}.brarchive`.split("/"))));
const listing = (entries) => entries.map((e) => (e.data.length ? e.name : `${e.name}(0)`));

test("brarchive を書いて読み戻す（名前・中身・長さ 0 の項目）", () => {
  const entries = [
    { name: "a.json", data: Buffer.from('{"a":1}') },
    { name: "日本語.json", data: Buffer.from("{}") },
    { name: "x.lang", data: Buffer.alloc(0) },
    { name: "b.png", data: Buffer.from([0, 1, 2, 3]) },
  ];
  const buf = encodeArchive(entries);
  assert.equal(buf.length, 16 + 4 * 256 + 7 + 2 + 4);
  assert.equal(buf.readUInt32LE(12), 1);
  const back = decodeArchive(buf);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => assert.ok(e.data.equals(entries[i].data)));
  // 長さ 0 の項目の位置は 0
  assert.equal(buf.readUInt32LE(16 + 2 * 256 + 248), 0);
  assert.throws(() => encodeArchive([{ name: "x".repeat(248), data: Buffer.alloc(0) }]));
  assert.throws(() => decodeArchive(Buffer.from("not an archive at all")));
});

test("公式のパックの brarchive を読める（あれば）", () => {
  const f = "C:/XboxGames/Minecraft for Windows/Content/data/behavior_packs/vanilla/__brarchive/items.brarchive";
  if (!fs.existsSync(f)) return;
  const buf = fs.readFileSync(f);
  const entries = decodeArchive(buf);
  assert.ok(entries.length > 10);
  assert.ok(encodeArchive(entries).equals(buf), "読んで書き直すと元と同じになる");
});

test("JSON の空白とコメントを抜く（数と文字列は書かれたまま）", () => {
  assert.equal(minifyJson('{\r\n\t"a" : [ 1 , 2 ] ,\n "b" : { } }'), '{"a":[1,2],"b":{}}');
  assert.equal(minifyJson('// 先頭\n{ "a": /* 中 */ 1 // 後ろ\n}\n// 最後'), '{"a":1}');
  assert.equal(minifyJson('{"n":[3.0, 1.50, 1e3, -0.0, 12345678901234567890]}'), '{"n":[3.0,1.50,1e3,-0.0,12345678901234567890]}');
  assert.equal(minifyJson('{"url": "https://x//y /* z */", "s": "a\\"b\\\\c\\u3042\\/"}'), '{"url":"https://x//y /* z */","s":"a\\"b\\\\c\\u3042\\/"}');
  assert.equal(minifyJson("\ufeff[ true, false, null ]"), "[true,false,null]");
  assert.equal(minifyJson('{"a":1,"a":2}'), '{"a":1,"a":2}');
  assert.equal(minifyJson('"str"'), '"str"');
  assert.equal(minifyJson(Buffer.from('{ "é" : "あ" }')), '{"é":"あ"}');
  // 読めないもの
  for (const bad of ['{"a":1,}', "[1,2,]", '{"a":NaN}', "{'a':1}", '{"a":1}{"b":2}', "", "{", '{"a":"x\ny"}', '{"a":"\\x41"}', '{"a":01}', '{"a":.5}', "/* 閉じない"]) {
    assert.equal(minifyJson(bad), null, bad);
  }
});

function samplePack(root) {
  put(root, "manifest.json", '{\n  "format_version": 2, // c\n  "header": { "name": "T", "uuid": "u", "version": [1, 0, 0] },\n  "modules": []\n}');
  put(root, "pack_icon.png", "PNG");
  put(root, "blocks.json", '{ "a" : 1 }');
  put(root, "items/b.json", '{ "x" : 3.0 }');
  put(root, "items/a.json", "{ }");
  put(root, "items/bad.json", '{ "x": 1, }');
  put(root, "items/sub/c.json", "[ 1 ]");
  put(root, "textures/blocks/t.png", "PNG");
  put(root, "textures/blocks/t.jpg", "JPG");
  put(root, "textures/terrain_texture.json", '{ "t" : 1 }');
  put(root, "texts/en_US.lang", "a=b");
  put(root, "texts/languages.json", '[ "en_US" ]');
  put(root, "loot_tables/x/y.json", '{ "pools" : [] }');
  put(root, "scripts/main.js", "console.log(1)");
  put(root, "scripts/main.js.map", "{}");
  put(root, "functions/f.mcfunction", "say hi");
  put(root, "structures/s.mcstructure", "NBT");
  put(root, "sounds/a.ogg", "OGG");
  put(root, "order/_x.json", "{}");
  put(root, "order/B.json", "{}");
  put(root, "order/a.json", "{}");
  put(root, "order/0.json", "{}");
  put(root, "subpacks/low/manifest_x.json", "{}");
  put(root, "subpacks/low/textures/q.png", "PNG");
  fs.mkdirSync(path.join(root, "empty", "deeper"), { recursive: true });
}

test("パックを brarchive の形にする（Mojang の PackOptimizer と同じきまり）", () => {
  const tmp = tmpdir();
  try {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    samplePack(src);
    const stats = bakePack(src, dst, { skip: (rel) => rel.endsWith(".map") });

    // ばらで残るもの
    assert.deepEqual(
      walk(dst).filter((f) => !f.includes("__brarchive/")),
      [
        "blocks.json",
        "items/bad.json",
        "loot_tables/x/y.json",
        "manifest.json",
        "pack_icon.png",
        "sounds/a.ogg",
        "structures/s.mcstructure",
        "subpacks/low/manifest_x.json",
        "texts/en_US.lang",
        "texts/languages.json",
        "textures/blocks/t.jpg",
        "textures/terrain_texture.json",
      ],
    );
    // 中身のあるフォルダだけ archive になる（empty は作らない）。サブパックは別に作る
    assert.deepEqual(walk(path.join(dst, "__brarchive")), [
      "functions.brarchive",
      "items.brarchive",
      "items/sub.brarchive",
      "loot_tables.brarchive",
      "loot_tables/x.brarchive",
      "order.brarchive",
      "scripts.brarchive",
      "sounds.brarchive",
      "structures.brarchive",
      "texts.brarchive",
      "textures.brarchive",
      "textures/blocks.brarchive",
    ]);
    assert.deepEqual(walk(path.join(dst, "subpacks", "low", "__brarchive")), ["textures.brarchive"]);

    // manifest: 空白とコメントを抜き、pack_optimization_version を足す
    const m = JSON.parse(fs.readFileSync(path.join(dst, "manifest.json"), "utf8"));
    assert.equal(m.header.pack_optimization_version, OPTIMIZATION_VERSION);
    assert.equal(m.format_version, 2);
    // 直下のほかのファイルはそのまま
    assert.equal(fs.readFileSync(path.join(dst, "blocks.json"), "utf8"), '{ "a" : 1 }');

    // 中身
    assert.deepEqual(listing(archive(dst, "items")), ["a.json", "b.json", "bad.json(0)"]);
    assert.equal(archive(dst, "items")[1].data.toString(), '{"x":3.0}');
    assert.deepEqual(listing(archive(dst, "order")), ["0.json", "B.json", "_x.json", "a.json"]);
    assert.deepEqual(listing(archive(dst, "texts")), ["en_US.lang(0)", "languages.json"]);
    assert.deepEqual(listing(archive(dst, "textures/blocks")), ["t.jpg(0)", "t.png"]);
    assert.deepEqual(listing(archive(dst, "scripts")), ["main.js"]); // ソースマップは入れない
    assert.deepEqual(listing(archive(dst, "functions")), ["f.mcfunction"]);
    assert.deepEqual(listing(archive(dst, "loot_tables")), []);
    // まとめたうえで、ばらでも残すもの（ばらの方も縮める）
    assert.equal(fs.readFileSync(path.join(dst, "texts", "languages.json"), "utf8"), '["en_US"]');
    assert.equal(fs.readFileSync(path.join(dst, "loot_tables", "x", "y.json"), "utf8"), '{"pools":[]}');
    assert.equal(fs.readFileSync(path.join(dst, "textures", "terrain_texture.json"), "utf8"), '{"t":1}');
    // 読めない JSON はそのまま
    assert.equal(fs.readFileSync(path.join(dst, "items", "bad.json"), "utf8"), '{ "x": 1, }');
    assert.deepEqual(stats.unreadable, ["items/bad.json"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Windows 版 BDS の PackOptimizer と出力を比べる。BKIT_BDS_EXE に bedrock_server.exe の場所を入れたときだけ動く
//   例: set BKIT_BDS_EXE=C:\...\bedrock-server-1.26.61.1\bedrock_server.exe && npm test
test("BDS の PackOptimizer と同じ結果になる（BKIT_BDS_EXE があるとき）", { skip: !process.env.BKIT_BDS_EXE }, () => {
  const tmp = tmpdir();
  try {
    const input = path.join(tmp, "in");
    samplePack(path.join(input, "T"));
    fs.rmSync(path.join(input, "T", "scripts", "main.js.map")); // bkit は配布物からソースマップを除くので、比べる前に消す
    const server = path.join(tmp, "server");
    fs.mkdirSync(server);
    fs.copyFileSync(process.env.BKIT_BDS_EXE, path.join(server, "bedrock_server.exe"));
    const cfg = path.join(tmp, "opt.json");
    fs.writeFileSync(cfg, JSON.stringify({ input_directory: input.replaceAll("\\", "/"), output_directory: path.join(tmp, "bds").replaceAll("\\", "/"), verbose_logging: false }));
    const r = spawnSync(path.join(server, "bedrock_server.exe"), [`PackOptimizerConfigPath=${cfg}`], { cwd: server, encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const bds = path.join(tmp, "bds", "T");
    const mine = path.join(tmp, "mine");
    bakePack(path.join(input, "T"), mine);

    assert.deepEqual(walk(mine), walk(bds), "同じファイルができる");
    const same = (a, b, name) => a.equals(b) || (name.endsWith(".json") && JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)));
    for (const f of walk(bds)) {
      const a = fs.readFileSync(path.join(bds, f));
      const b = fs.readFileSync(path.join(mine, f));
      if (!f.endsWith(".brarchive")) {
        assert.ok(same(a, b, f), f);
        continue;
      }
      const ea = decodeArchive(a);
      const eb = decodeArchive(b);
      assert.deepEqual(listing(eb), listing(ea), f);
      ea.forEach((e, i) => assert.ok(same(e.data, eb[i].data, e.name), `${f} の ${e.name}`));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
