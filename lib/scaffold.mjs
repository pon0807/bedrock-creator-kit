// 新しいアドオンの雛形と、既存プロジェクトの移行、VS Code の設定
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { log, color, readJson, writeJson, writeJsonKeepStyle, toPosix, run, runCapture, parseVersion, KIT_ROOT } from "./util.mjs";
import { loadPacks, CONFIG_FILE, addonsOf } from "./project.mjs";
import { resolveTargets, PRODUCTS } from "./targets.mjs";
import { commonStable, npmVersions, versionChoices, MODULE_INFO } from "./compat.mjs";
import { KIT_NAME, findWorkspace, loadSettings } from "./settings.mjs";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

// ---------- 共通ファイル ----------
// 道具はパッケージ名（bedrock-creator-kit）で参照する。ワークスペースの node_modules から見つかるので、
// プロジェクトをどの PC に置いても同じ設定のまま動く
export function writeTsconfig(root, { strict = true, dom = false } = {}) {
  const tsconfig = {
    extends: `${KIT_NAME}/tsconfig.base.json`,
    compilerOptions: strict ? {} : { strict: false, noImplicitAny: false },
    include: ["behavior_packs/**/*.ts"],
  };
  if (dom) {
    tsconfig.compilerOptions.lib = ["ES2022", "DOM"];
    tsconfig.compilerOptions.types = [`${KIT_NAME}/types/dev`];
  }
  writeJson(path.join(root, "tsconfig.json"), tsconfig);
}

export function writeEslintConfig(root, { force = false } = {}) {
  const f = path.join(root, "eslint.config.mjs");
  if (fs.existsSync(f) && !force && fs.readFileSync(f, "utf8").includes(KIT_NAME)) return;
  if (fs.existsSync(f) && !force && !fs.readFileSync(f, "utf8").includes("eslint.base.mjs")) return; // 自分で書いた設定は残す
  fs.writeFileSync(f, `// ESLint の設定。共通の中身は ${KIT_NAME}/eslint.base.mjs\nimport base from "${KIT_NAME}/eslint.base.mjs";\n\nexport default [...base];\n`);
}

export function writeGitignore(root) {
  const f = path.join(root, ".gitignore");
  const drop = new Set(["/gulpfile.js", "gulpfile.js", "/package.json", "package.json", "/package-lock.json", "package-lock.json", "/node_modules", "node_modules"]);
  const old = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim() && !drop.has(l.trim())) : [];
  const need = ["node_modules/", ".bkit/", "dist/", ".env.local"];
  const lines = [...need, ...old.filter((l) => !need.includes(l.trim()))];
  fs.writeFileSync(f, lines.join("\n") + "\n");
}

export function writeVscode(root) {
  const dir = path.join(root, ".vscode");
  fs.mkdirSync(dir, { recursive: true });

  // settings.json（既存の設定は残す。PC ごとに違うパスは書かない）
  const sf = path.join(dir, "settings.json");
  const settings = fs.existsSync(sf) ? readJson(sf) : {};
  settings["files.exclude"] = { ...(settings["files.exclude"] ?? {}), "**/.bkit": true };
  settings["search.exclude"] = { ...(settings["search.exclude"] ?? {}), "**/dist": true, "**/.bkit": true };
  delete settings["eslint.nodePath"];
  delete settings["eslint.useFlatConfig"];
  delete settings["typescript.tsdk"];
  writeJson(sf, settings);

  // extensions.json
  const ef = path.join(dir, "extensions.json");
  const ext = fs.existsSync(ef) ? readJson(ef) : {};
  const rec = new Set([...(ext.recommendations ?? []), "blockceptionltd.blockceptionvscodeminecraftbedrockdevelopmentextension", "mojang-studios.minecraft-debugger", "jannisx11.snowstorm", "dbaeumer.vscode-eslint"]);
  writeJson(ef, { ...ext, recommendations: [...rec] });

  // tasks.json（Ctrl+Shift+B で見張りを始める）
  const tf = path.join(dir, "tasks.json");
  const tasks = fs.existsSync(tf) ? readJson(tf) : { version: "2.0.0", tasks: [] };
  tasks.tasks = (tasks.tasks ?? []).filter((t) => !String(t.label).startsWith("bkit:"));
  tasks.tasks.push(
    { label: "bkit: 見張り（watch）", type: "npm", script: "watch", isBackground: true, problemMatcher: [], group: { kind: "build", isDefault: true } },
    { label: "bkit: 1 回ビルド", type: "npm", script: "build", problemMatcher: [] },
    { label: "bkit: チェック", type: "npm", script: "check", problemMatcher: ["$tsc"] },
  );
  writeJson(tf, tasks);

  writeLaunch(root);
}

// launch.json（スクリプトのある BP ごとに、デバッガの設定を作る）
export function writeLaunch(root) {
  const lf = path.join(root, ".vscode", "launch.json");
  const launch = fs.existsSync(lf) ? readJson(lf) : { version: "0.2.0", configurations: [] };
  launch.configurations = (launch.configurations ?? []).filter((c) => !String(c.name).startsWith("Minecraft につなぐ"));
  for (const p of loadPacks(root).filter((x) => x.script)) {
    const scriptsDir = p.script.entry.split("/").slice(0, -1).join("/");
    const stage = `\${workspaceFolder}/.bkit/stage/dev/${p.dirName}/${p.name}/${scriptsDir}`;
    launch.configurations.push({
      type: "minecraft-js",
      request: "attach",
      name: `Minecraft につなぐ（${p.name}）`,
      mode: "listen",
      port: 19144,
      localRoot: `\${workspaceFolder}/${p.dirName}/${p.name}/${scriptsDir}`,
      sourceMapRoot: stage,
      generatedSourceRoot: stage,
      targetModuleUuid: p.script.uuid,
    });
  }
  writeJson(lf, launch);
}

// ---------- アイコン（単色の PNG） ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makeIcon(seed, size = 128) {
  const h = crypto.createHash("md5").update(seed).digest();
  const [r, g, b] = [80 + (h[0] % 140), 80 + (h[1] % 140), 80 + (h[2] % 140)];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const edge = x < 8 || y < 8 || x >= size - 8 || y >= size - 8;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = edge ? r * 0.6 : r; raw[o + 1] = edge ? g * 0.6 : g; raw[o + 2] = edge ? b * 0.6 : b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------- 版の決め方 ----------
// manifest の版に合う型の版。beta は送り先の一番古いゲームの版に合わせる
function pickTypesVersion(moduleName, manifestVersion, engines = []) {
  const v = parseVersion(manifestVersion);
  if (!v) return null;
  if (!v.pre) return v.nums.join(".");
  if (!v.pre.startsWith("beta")) return null; // alpha などは npm に無い
  const list = npmVersions(moduleName) ?? [];
  const head = `${v.nums.join(".")}-beta.`;
  const low = [...engines].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])[0];
  if (low) {
    const exact = `${head}${low.join(".")}-stable`;
    if (list.includes(exact)) return exact;
  }
  const hits = list.filter((x) => x.startsWith(head) && x.endsWith("-stable"));
  return hits[hits.length - 1] ?? list.filter((x) => x.startsWith(head)).pop() ?? null;
}

// Mojang の beta 版どうしは peerDependencies が噛み合わないことがあるので、緩めて入れる
export function writeNpmrc(root) {
  const f = path.join(root, ".npmrc");
  const text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  if (/legacy-peer-deps/.test(text)) return;
  fs.writeFileSync(f, (text.trim() ? text.trimEnd() + "\n" : "") + "# Minecraft の beta 版パッケージは peer の指定が厳しいので緩める（bkit）\nlegacy-peer-deps=true\n");
}

function npmInstall(root) {
  log.step("npm install");
  writeNpmrc(root);
  return run(npmCmd, ["install", "--no-fund", "--no-audit", "--loglevel=error"], { cwd: root, shell: true });
}

// ---------- 新しいアドオン ----------
const MODULE_ALIASES = {
  server: "@minecraft/server",
  ui: "@minecraft/server-ui",
  "server-ui": "@minecraft/server-ui",
  net: "@minecraft/server-net",
  "server-net": "@minecraft/server-net",
  admin: "@minecraft/server-admin",
  "server-admin": "@minecraft/server-admin",
  gametest: "@minecraft/server-gametest",
  "server-gametest": "@minecraft/server-gametest",
  debug: "@minecraft/debug-utilities",
  "debug-utilities": "@minecraft/debug-utilities",
  math: "@minecraft/math",
  "vanilla-data": "@minecraft/vanilla-data",
  vanilla: "@minecraft/vanilla-data",
};

// "server@2.8.0,ui" → [{ name, version }]（版を省くとおすすめの版）
export function parseModules(spec, targets) {
  const items = Array.isArray(spec) ? spec : String(spec).split(",").map((s) => s.trim()).filter(Boolean);
  return items.map((it) => {
    if (typeof it === "object") return it;
    const at = it.lastIndexOf("@");
    const rawName = at > 0 ? it.slice(0, at) : it;
    const name = MODULE_ALIASES[rawName] ?? rawName;
    const version = at > 0 ? it.slice(at + 1) : versionChoices(name, targets).recommended;
    return { name, version };
  });
}

function gitUserName() {
  const r = runCapture("git", ["config", "user.name"], { shell: true });
  return r.status === 0 ? r.stdout.trim() : "";
}

// 引数からモジュールの一覧を決める（--modules / --no-modules / 昔の --no-scripts --no-ui --beta）
function resolveModules(args, targets, withBp) {
  if (args.modules !== undefined && args.modules !== true) return args.modules === false ? [] : parseModules(args.modules, targets);
  if (!withBp || args.scripts === false) return [];
  const def = ["server", ...(args.ui === false ? [] : ["ui"]), ...(args.libs === false ? [] : ["math", "vanilla-data"])];
  let modules = parseModules(def, targets);
  if (args.beta) {
    modules = modules.map((m) => {
      const c = versionChoices(m.name, targets).options.find((o) => o.value.endsWith("-beta"));
      return MODULE_INFO[m.name]?.kind === "module" && c ? { ...m, version: c.value } : m;
    });
  }
  return modules;
}

function parsePacks(args) {
  let packs = String(args.packs ?? "bp,rp").split(",").map((s) => s.trim().toLowerCase().replace(/^skin$/, "sp")).filter(Boolean);
  if (args.rp === false) packs = packs.filter((x) => x !== "rp");
  return packs;
}

// 1 つのアドオンのパック（BP / RP / SP）を書き出す。作ったパックの情報を返す
//   requires: 依存するアドオンのパック（[{ kind, name, uuid, version }]）。BP から依存を書く
function writeAddonPacks(root, { packBase, addonId, display, packs, modules, targets, author, requires = [] }) {
  const withBp = packs.includes("bp");
  const withRp = packs.includes("rp");
  const withSp = packs.includes("sp");
  const scriptModules = modules.filter((m) => MODULE_INFO[m.name]?.kind !== "lib");
  const libs = modules.filter((m) => MODULE_INFO[m.name]?.kind === "lib");
  if (scriptModules.length && !withBp) throw new Error("スクリプトのモジュールはビヘイビアーパックに入るので、BP も選んでください");
  for (const m of [...scriptModules]) {
    const need = MODULE_INFO[m.name]?.needs;
    if (need && !scriptModules.some((x) => x.name === need)) {
      scriptModules.unshift({ name: need, version: versionChoices(need, targets).recommended });
      log.info(`${m.name} は ${need} が要るので足しました`);
    }
    if (MODULE_INFO[m.name]?.bdsOnly && !targets.some((t) => t.kind === "bds")) log.warn(`${m.name} は BDS（サーバー）でしか動きません`);
  }
  const withScripts = scriptModules.length > 0;
  const engines = targets.map((t) => t.engine).filter(Boolean);
  const low = [...engines].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])[0] ?? [1, 21, 90];
  const minEngine = `${low[0]}.${low[1]}.${Math.floor(low[2] / 10) * 10}`;
  for (const m of [...scriptModules, ...libs]) log.info(`${m.name} ${m.version}`);

  const metadata = { authors: [author], generated_with: { bkit: [readJson(path.join(KIT_ROOT, "package.json")).version] } };
  const u = () => crypto.randomUUID();
  const names = { bp: `${packBase}_${addonId}BP`, rp: `${packBase}_${addonId}RP`, sp: `${packBase}_${addonId}SP` };
  for (const [k, n] of Object.entries(names)) {
    const dir = path.join(root, { bp: "behavior_packs", rp: "resource_packs", sp: "skin_packs" }[k], n);
    if (packs.includes(k) && fs.existsSync(dir)) throw new Error(`同じ名前のパックがもうあります: ${n}`);
  }
  const bpUuid = u();
  const rpUuid = u();
  const created = [];
  const lang = (suffix) => `pack.name=${display}[${suffix}]\npack.description=${display}\n`;
  const writeTexts = (dir, text) => {
    fs.mkdirSync(path.join(dir, "texts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "texts", "ja_JP.lang"), text);
    fs.writeFileSync(path.join(dir, "texts", "en_US.lang"), text);
    writeJson(path.join(dir, "texts", "languages.json"), ["ja_JP", "en_US"]);
  };

  // BP（manifest は format_version 3: 版はすべて文字列、metadata.authors が要る）
  if (withBp) {
    const bpDir = path.join(root, "behavior_packs", names.bp);
    const m = {
      format_version: 3,
      header: { name: "pack.name", description: "pack.description", uuid: bpUuid, version: "1.0.0", min_engine_version: minEngine },
      modules: [{ type: "data", uuid: u(), version: "1.0.0" }],
      dependencies: [],
      metadata,
    };
    if (withScripts) {
      m.modules.push({ type: "script", language: "javascript", uuid: u(), version: "1.0.0", entry: "scripts/main.js" });
      for (const s of scriptModules) m.dependencies.push({ module_name: s.name, version: s.version });
    }
    if (withRp) m.dependencies.push({ uuid: rpUuid, version: "1.0.0" });
    for (const r of requires) m.dependencies.push({ uuid: r.uuid, version: r.version });
    if (!m.dependencies.length) delete m.dependencies;
    writeJson(path.join(bpDir, "manifest.json"), m, "\t");
    fs.writeFileSync(path.join(bpDir, "pack_icon.png"), makeIcon(packBase + addonId + "BP"));
    writeTexts(bpDir, lang("BP"));
    if (withScripts) {
      fs.mkdirSync(path.join(bpDir, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(bpDir, "scripts", "main.ts"), "console.log('Addon Loaded!')\n");
    }
    created.push(names.bp);
  }

  // RP（BP が無いアドオンの RP は、依存するアドオンを RP から指す）
  if (withRp) {
    const rpDir = path.join(root, "resource_packs", names.rp);
    const m = {
      format_version: 3,
      header: { name: "pack.name", description: "pack.description", uuid: rpUuid, version: "1.0.0", min_engine_version: minEngine },
      modules: [{ type: "resources", uuid: u(), version: "1.0.0" }],
      metadata,
    };
    if (!withBp && requires.length) m.dependencies = requires.map((r) => ({ uuid: r.uuid, version: r.version }));
    writeJson(path.join(rpDir, "manifest.json"), m, "\t");
    fs.writeFileSync(path.join(rpDir, "pack_icon.png"), makeIcon(packBase + addonId + "RP"));
    writeTexts(rpDir, lang("RP"));
    created.push(names.rp);
  }

  // スキンパック（公式の説明では format_version 1）
  if (withSp) {
    const spDir = path.join(root, "skin_packs", names.sp);
    const serialize = `${packBase}${addonId === "main" ? "" : "_" + addonId}`;
    writeJson(path.join(spDir, "manifest.json"), {
      format_version: 1,
      header: { name: `${display}[SP]`, uuid: u(), version: [1, 0, 0] },
      modules: [{ type: "skin_pack", uuid: u(), version: [1, 0, 0] }],
    }, "\t");
    writeJson(path.join(spDir, "skins.json"), {
      // 名前の _custom は体型（細い体型なら _customSlim と geometry.humanoid.customSlim）
      skins: [{ localization_name: "default_custom", geometry: "geometry.humanoid.custom", texture: "default_custom.png", type: "free" }],
      serialize_name: serialize,
      localization_name: serialize,
    }, "\t");
    fs.writeFileSync(path.join(spDir, "default_custom.png"), makeSkin(packBase + addonId));
    writeTexts(spDir, `skinpack.${serialize}=${display}\nskin.${serialize}.default_custom=${display}\n`);
    created.push(names.sp);
  }

  const deps = {};
  for (const s of scriptModules) {
    const v = pickTypesVersion(s.name, s.version, engines);
    if (v) deps[s.name] = v;
  }
  for (const l of libs) deps[l.name] = l.version;
  return { created, deps, withScripts };
}

function authorFrom(args) {
  return typeof args.author === "string" ? args.author : loadSettings().author || gitUserName() || "unknown";
}

export async function createProject(args) {
  const name = args._[0];
  if (!name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    log.error("名前を英数字で指定してください（例: bkit new MyAddon --targets bedrock,education）");
    return 1;
  }
  const targetsList = String(args.targets ?? "bedrock").split(",").map((s) => s.trim()).filter(Boolean);
  const channel = args.channel ?? (targetsList.every((t) => t.includes("preview")) ? "preview" : "stable");
  const ws = findWorkspace();
  if (!args.dir && !ws) {
    log.error("アドオンを置くフォルダ（ワークスペース）がまだありません。先に bkit setup をしてください");
    return 1;
  }
  const root = args.dir ? path.resolve(String(args.dir), name) : path.join(ws, channel, name);
  if (fs.existsSync(root)) { log.error(`同じ名前のアドオンがもうあります: ${root}`); return 1; }
  const packs = parsePacks(args);
  if (!packs.length) { log.error("作るパックを 1 つ以上選んでください（--packs bp,rp,sp）"); return 1; }
  const display = typeof args.display === "string" ? args.display : name;
  const packBase = name.replace(/[-\s]/g, "");

  const fakeProject = { root, config: { targets: targetsList, bds: args.bds ? { server: path.resolve(args.bds), world: args.world } : undefined } };
  const targets = resolveTargets(fakeProject);
  for (const t of targets) log.info(`送り先 ${t.label}${t.engine ? `（${t.engine.join(".")}）` : color.yellow("（版が分からない）")}`);
  const modules = resolveModules(args, targets, packs.includes("bp"));

  let out;
  try {
    out = writeAddonPacks(root, { packBase, addonId: "main", display, packs, modules, targets, author: authorFrom(args) });
  } catch (e) {
    log.error(e.message);
    return 1;
  }

  // 設定ファイル
  const config = { name, display, targets: targetsList, addons: [{ id: "main", display, packs: out.created }] };
  if (fakeProject.config.bds) config.bds = { server: toPosix(path.relative(root, fakeProject.config.bds.server)), world: args.world ?? "Bedrock level" };
  writeJson(path.join(root, CONFIG_FILE), config);
  writePackageJson(root, { name, deps: out.deps });
  if (out.withScripts) {
    writeTsconfig(root, { strict: true });
    writeEslintConfig(root);
  }
  writeGitignore(root);
  writeVscode(root);
  writeProjectClaudeMd(root, { name, display });
  writeReadme(root, { name, display, targets: targetsList });

  if (args.install !== false && Object.keys(out.deps).length && npmInstall(root) !== 0) log.warn("npm install に失敗しました。あとでプロジェクトのフォルダで npm install してください");
  if (args.git !== false) run("git", ["init", "-q", "-b", "main"], { cwd: root });
  log.ok(`できました: ${root}`);
  return 0;
}

// 今あるプロジェクトに、2 つ目以降のアドオンを足す（bkit add）
export async function addAddon(project, args) {
  const id = args._[0];
  if (!id || !/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
    log.error("アドオンの名前を英数字で指定してください（例: bkit add extra --requires main）。パックのフォルダ名は <プロジェクト>_<名前>BP になります");
    return 1;
  }
  const existing = addonsOf(project);
  if (existing.some((a) => a.id === id)) { log.error(`同じ名前のアドオンがもうあります: ${id}`); return 1; }
  const packs = parsePacks(args);
  if (!packs.length) { log.error("作るパックを 1 つ以上選んでください（--packs bp,rp,sp）"); return 1; }
  const display = typeof args.display === "string" ? args.display : id;
  const packBase = (project.config.name ?? project.name).replace(/[-\s]/g, "");
  const targets = resolveTargets(project);

  // 依存するアドオン（拡張なら本体）。BP があればその BP、なければ RP を指す
  const reqIds = args.requires ? String(args.requires).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const requires = [];
  for (const rid of reqIds) {
    const a = existing.find((x) => x.id === rid);
    if (!a) { log.error(`依存先のアドオンがありません: ${rid}（あるのは ${existing.map((x) => x.id).join(", ")}）`); return 1; }
    const target = a.packs.find((p) => p.kind === "bp") ?? a.packs.find((p) => p.kind === "rp");
    if (!target) { log.warn(`${rid} には BP も RP もないので、依存は書きません`); continue; }
    requires.push({ uuid: target.manifest.header.uuid, version: target.manifest.header.version });
  }

  // モジュールの版は、なるべくプロジェクトで使っている版に合わせる（型が 1 つしか入らないため）
  let modules = resolveModules(args, targets, packs.includes("bp"));
  const pj = path.join(project.root, "package.json");
  const used = fs.existsSync(pj) ? readJson(pj).dependencies ?? {} : {};
  for (const m of modules) {
    const cur = project.packs.flatMap((p) => p.manifest.dependencies ?? []).find((d) => d.module_name === m.name);
    if (cur && cur.version !== m.version) log.warn(`${m.name}: ほかのアドオンは ${cur.version}、このアドオンは ${m.version}。型は 1 つしか入らないので、揃えるのがおすすめ`);
  }

  let out;
  try {
    out = writeAddonPacks(project.root, { packBase, addonId: id, display, packs, modules, targets, author: authorFrom(args), requires });
  } catch (e) {
    log.error(e.message);
    return 1;
  }

  // addon.config.json に書く（今まで一覧が無かったなら、今あるパックを main として先に書く）
  const cfgFile = path.join(project.root, CONFIG_FILE);
  const cfg = readJson(cfgFile);
  if (!Array.isArray(cfg.addons) || !cfg.addons.length) {
    cfg.addons = [{ id: "main", display: cfg.display ?? project.name, packs: project.packs.map((p) => p.name) }];
  }
  cfg.addons.push({ id, display, packs: out.created, ...(reqIds.length ? { requires: reqIds } : {}) });
  writeJson(cfgFile, cfg);

  // 型（npm）は、まだ入っていないものだけ足す
  const add = Object.fromEntries(Object.entries(out.deps).filter(([k]) => !used[k]));
  if (Object.keys(add).length) {
    writePackageJson(project.root, { name: readJson(pj).name ?? project.name, deps: add });
    if (args.install !== false) npmInstall(project.root);
  }
  if (out.withScripts && !fs.existsSync(path.join(project.root, "tsconfig.json"))) {
    writeTsconfig(project.root, { strict: true });
    writeEslintConfig(project.root);
  }
  writeLaunch(project.root);
  log.ok(`アドオン「${display}」（${id}）を足しました: ${out.created.join(", ")}`);
  return 0;
}

// スキンの仮の絵（64×64。体の部分だけ塗り、上着などの重ねる層は透明）
export function makeSkin(seed) {
  const h = crypto.createHash("md5").update(seed + "skin").digest();
  const skinColor = [224, 172, 132];
  const shirt = [60 + (h[0] % 160), 60 + (h[1] % 160), 60 + (h[2] % 160)];
  const pants = [40 + (h[3] % 80), 40 + (h[4] % 80), 90 + (h[5] % 120)];
  const W = 64;
  const raw = Buffer.alloc((W * 4 + 1) * W);
  const paint = (x0, y0, x1, y1, c) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = y * (W * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  };
  paint(0, 0, 32, 16, skinColor);   // 頭
  paint(16, 16, 40, 32, shirt);     // 胴
  paint(40, 16, 56, 32, shirt);     // 右腕
  paint(0, 16, 16, 32, pants);      // 右脚
  paint(16, 48, 32, 64, pants);     // 左脚
  paint(32, 48, 48, 64, shirt);     // 左腕
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

export function writePackageJson(root, { name, deps = {}, libs = false, keep } = {}) {
  const f = path.join(root, "package.json");
  const old = keep ?? (fs.existsSync(f) ? readJson(f) : {});
  const removeDev = ["gulp", "gulp-changed", "gulp-typescript", "typescript", "dotenv", "@minecraft/core-build-tasks", "just-scripts", "ts-node", "source-map", "eslint-plugin-minecraft-linting", "eslint", "typescript-eslint", "esbuild"];
  const devDependencies = Object.fromEntries(Object.entries(old.devDependencies ?? {}).filter(([k]) => !removeDev.includes(k)));
  // 前の版の書き方（道具を file: でつないでいた）は外す。道具はワークスペースに入れる
  for (const k of ["bedrock-kit", "pon-bedrock-kit"]) if (String(devDependencies[k] ?? "").startsWith("file:")) delete devDependencies[k];
  const dependencies = { ...(old.dependencies ?? {}), ...deps };
  if (libs) {
    dependencies["@minecraft/math"] ??= "^2.2.11";
    dependencies["@minecraft/vanilla-data"] ??= "^1.21.90";
  }
  for (const k of Object.keys(dependencies)) if (dependencies[k] == null) delete dependencies[k];
  const oldScripts = Object.fromEntries(Object.entries(old.scripts ?? {}).filter(([k, v]) => !/gulp|just-scripts|CheckNetIsolation/.test(String(v)) && !["watch", "build", "lint"].includes(k)));
  const pkg = {
    name: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
    version: old.version ?? "1.0.0",
    private: true,
    description: old.description && old.description !== "Minecraft Bedrock Edition addon development environment" ? old.description : `${name}（統合版アドオン）`,
    scripts: {
      watch: "bkit watch",
      build: "bkit build",
      check: "bkit check",
      "check:strict": "bkit check --strict",
      lint: "bkit lint",
      "lint:fix": "bkit lint --fix",
      validate: "bkit validate",
      release: "bkit release",
      doctor: "bkit doctor",
      ...oldScripts,
    },
    devDependencies,
    dependencies,
  };
  writeJson(f, pkg);
}

export function writeProjectClaudeMd(root, { name, display }) {
  const f = path.join(root, "CLAUDE.md");
  const marker = "<!-- bkit -->";
  const body = `${marker}
## 開発環境（bkit）

このプロジェクトは共通の道具 bkit（パッケージ名 \`bedrock-creator-kit\`）でビルドする。道具はワークスペース（\`bkit-workspace.json\` のあるフォルダ）の \`node_modules\` に 1 回だけ入れてあり、プロジェクトはその中の \`stable/\` か \`preview/\` に置く。迷ったら \`bkit\` と打つとメニューが出る。

- 送り先は \`addon.config.json\` の \`targets\`（bedrock / preview / education / education-preview / bds）
- \`npm run watch\` 見張り / \`npm run build\` 1 回送る / \`npm run check\` 型・ESLint・版・UUID / \`npm run validate\` Creator Tools の検証 / \`npm run release -- patch\` 配布ファイル
- スクリプトは \`behavior_packs/<BP>/scripts/\` の TS。esbuild で 1 本にまとめるので、npm のライブラリを import してよい（\`@minecraft/server\` などは外部扱い）
- manifest の API の版を上げるときは、送り先すべてで動くか \`npm run check\` で確かめる。教育版は本体より古い
- UUID は手で書かない（\`bkit uuid --new\`）。\`.bkit/\` と \`dist/\` は生成物なので直さない
- \`dev:\` ラベルの付いた文と \`__DEV__\` の分岐は、配布物から消える
`;
  if (fs.existsSync(f)) {
    const text = fs.readFileSync(f, "utf8");
    // bkit の節は毎回書き直す（ほかの部分は残す）
    const i = text.indexOf(marker);
    fs.writeFileSync(f, (i >= 0 ? text.slice(0, i).trimEnd() : text.trimEnd()) + "\n\n" + body);
  } else {
    fs.writeFileSync(f, `# ${display}\n\n${name} の統合版アドオン。\n\n${body}`);
  }
}

function writeReadme(root, { name, display, targets }) {
  fs.writeFileSync(path.join(root, "README.md"), `# ${display}

統合版アドオン（${name}）。送り先: ${targets.map((t) => PRODUCTS[t]?.label ?? t).join("・")}

## 使い方

\`\`\`bash
npm run watch      # 変更を見張って、ゲームに送り続ける（VS Code では Ctrl+Shift+B）
npm run check      # 型・ESLint・送り先の版・UUID の重複
npm run validate   # Minecraft Creator Tools の検証
npm run release    # 版を上げて dist/ に .mcaddon を作る（-- minor / -- major / -- none）
\`\`\`

デバッガ: VS Code で F5 →「Minecraft につなぐ」→ ゲーム内で \`/script debugger connect localhost 19144\`
`);
}

// ---------- 既存プロジェクトの移行 ----------
export function migrateProject(root, { targets, install = true, dryRun = false } = {}) {
  root = path.resolve(root);
  const name = path.basename(root);
  const packs = loadPacks(root);
  if (!packs.length) { log.error(`${name}: behavior_packs / resource_packs / skin_packs にパックがありません`); return 1; }
  if (fs.existsSync(path.join(root, CONFIG_FILE))) { log.info(`${name}: もう移行済みです（${CONFIG_FILE} がある）`); return 0; }
  const channel = path.basename(path.dirname(root));
  const t = targets ?? (channel === "preview" ? ["preview"] : ["bedrock"]);
  log.step(`${color.bold(name)} を移行します（送り先: ${t.join(", ")}）`);
  if (dryRun) return 0;

  // 古い設定は .bkit/backup に退避（消さない）
  const stamp = new Date().toISOString().slice(0, 10);
  const backup = path.join(root, ".bkit", "backup", stamp);
  fs.mkdirSync(backup, { recursive: true });
  for (const f of ["package.json", "tsconfig.json", ".gitignore", "gulpfile.js"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(backup, f));
  }
  if (fs.existsSync(path.join(root, "gulpfile.js"))) fs.renameSync(path.join(root, "gulpfile.js"), path.join(backup, "gulpfile.js.moved"));

  // 型の版を manifest に揃える
  const engines = resolveTargets({ root, config: { targets: t } }).map((x) => x.engine).filter(Boolean);
  const deps = {};
  for (const p of packs) for (const d of p.manifest.dependencies ?? []) {
    if (!d.module_name) continue;
    const v = pickTypesVersion(d.module_name, d.version, engines);
    if (v) deps[d.module_name] = v;
  }
  const hasTs = packs.some((p) => p.script?.source?.endsWith(".ts"));
  writeJson(path.join(root, CONFIG_FILE), { name, targets: t });
  writePackageJson(root, { name, deps });
  if (hasTs || fs.existsSync(path.join(root, "tsconfig.json"))) writeTsconfig(root, { strict: false, dom: true });
  writeEslintConfig(root);
  writeGitignore(root);
  writeVscode(root);
  writeProjectClaudeMd(root, { name, display: name });
  if (install && npmInstall(root) !== 0) { log.warn(`${name}: npm install に失敗しました`); return 1; }
  log.ok(`${name}: 移行しました（古い設定は .bkit/backup/${stamp}）`);
  return 0;
}
