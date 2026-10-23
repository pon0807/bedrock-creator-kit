// ビルド（esbuild でスクリプトを 1 本にまとめる）と、送り先へのコピー、変更の見張り
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import gulp from "gulp";
import { log, color, walk, rmrf, copyIfChanged, toPosix, globToRegExp, nodeBin, parseJsonLoose } from "./util.mjs";
import { loadProject } from "./project.mjs";
import { resolveTargets, packDestRoot, registerPacksOnBds } from "./targets.mjs";
import { NATIVE_MODULES } from "./compat.mjs";

export const stageDir = (project, mode) => path.join(project.root, ".bkit", "stage", mode);
export const stagePackDir = (project, mode, pack) => path.join(stageDir(project, mode), pack.dirName, pack.name);

function makeExcluder(project) {
  const res = project.config.exclude.map(globToRegExp);
  return (relPosix) => res.some((re) => re.test(relPosix));
}

function esbuildOptions(project, pack, mode) {
  const outfile = path.join(stagePackDir(project, mode, pack), pack.script.entry);
  const external = new Set([...NATIVE_MODULES, ...(project.config.external ?? [])]);
  for (const d of pack.manifest.dependencies ?? []) if (d.module_name) external.add(d.module_name);
  return {
    entryPoints: [pack.script.source],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: project.config.esTarget ?? "es2020",
    mainFields: ["module", "main"],
    external: [...external],
    sourcemap: mode === "dev" ? "external" : false,
    sourcesContent: true,
    dropLabels: mode === "prod" ? ["dev"] : [],
    drop: mode === "prod" ? ["debugger"] : [],
    define: { __DEV__: mode === "dev" ? "true" : "false" },
    // 配布物は圧縮する（変数名の短縮・空白と改行の削除）。addon.config.json の "minify": false で止められる
    minify: mode === "prod" && project.config.minify !== false,
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
    absWorkingDir: project.root,
    tsconfig: fs.existsSync(path.join(project.root, "tsconfig.json")) ? path.join(project.root, "tsconfig.json") : undefined,
  };
}

function printEsbuildErrors(err, project) {
  const errors = err?.errors ?? [];
  if (!errors.length) {
    log.error(String(err?.message ?? err));
    return;
  }
  for (const e of errors) {
    const loc = e.location ? `${path.relative(project.root, path.resolve(project.root, e.location.file))}:${e.location.line}:${e.location.column + 1}` : "";
    log.error(`${color.bold(loc)} ${e.text}`);
    if (e.location?.lineText) console.log(color.gray(`      ${e.location.lineText.trim()}`));
  }
}

// パックの中身（スクリプト以外）を stage にコピー
function stageStatic(project, mode, pack, excluded) {
  const out = stagePackDir(project, mode, pack);
  const files = walk(pack.dir, { skip: (full, ent) => ent.isDirectory() && ent.name === "node_modules" });
  let n = 0;
  for (const f of files) {
    const rel = toPosix(path.relative(pack.dir, f));
    if (excluded(rel)) continue;
    if (pack.script?.source && rel.split("/")[0] === pack.script.rootDir) continue; // バンドルするので送らない
    copyIfChanged(f, path.join(out, rel));
    n++;
  }
  return n;
}

async function bundleScript(project, mode, pack) {
  if (!pack.script) return true;
  if (!pack.script.source) {
    log.warn(`${pack.name}: manifest の entry「${pack.script.entry}」に対応する .ts / .js がありません`);
    return false;
  }
  try {
    await esbuild.build(esbuildOptions(project, pack, mode));
    return true;
  } catch (e) {
    printEsbuildErrors(e, project);
    return false;
  }
}

// ---------- 送り先の安全確認 ----------
// bkit が送ったパックのフォルダには目印（.bkit.json）を置く。
// 目印もなく、manifest の UUID も違うフォルダ（ほかのアドオン）は、消さずに止める
export const MARK_FILE = ".bkit.json";
const blocked = new Set();
const destKey = (t, pack) => `${t.root}|${pack.kind}|${pack.name}`;
export const isBlocked = (t, pack) => blocked.has(destKey(t, pack));

export function checkDest(t, pack) {
  const dest = path.join(packDestRoot(t, pack.kind), pack.name);
  const uuid = String(pack.manifest.header.uuid).toLowerCase();
  if (!fs.existsSync(dest)) return { ok: true, dest };
  const mark = path.join(dest, MARK_FILE);
  if (fs.existsSync(mark)) {
    try {
      const m = JSON.parse(fs.readFileSync(mark, "utf8"));
      if (String(m.uuid).toLowerCase() === uuid) return { ok: true, dest };
      return { ok: false, dest, reason: `bkit で送った別のパック（UUID ${m.uuid}）です` };
    } catch { /* 目印が壊れていたら manifest で判断する */ }
  }
  const mf = path.join(dest, "manifest.json");
  if (fs.existsSync(mf)) {
    try {
      const m = parseJsonLoose(fs.readFileSync(mf, "utf8"), mf);
      if (String(m?.header?.uuid).toLowerCase() === uuid) return { ok: true, dest, adopted: true }; // 同じパックの古い写し
      return { ok: false, dest, reason: `別のパック（${m?.header?.name ?? "名前なし"}、UUID ${m?.header?.uuid ?? "なし"}）です` };
    } catch {
      return { ok: false, dest, reason: "manifest.json を読めないフォルダです" };
    }
  }
  if (!fs.readdirSync(dest).length) return { ok: true, dest };
  return { ok: false, dest, reason: "bkit が送ったものではないファイルが入っています" };
}

// stage の中身を送り先に（.map は送らない）
function deployPack(project, mode, pack, targets, { clean = true } = {}) {
  const src = stagePackDir(project, mode, pack);
  const files = walk(src).filter((f) => !f.endsWith(".map"));
  for (const t of targets) {
    if (!t.root) continue;
    const c = checkDest(t, pack);
    const k = destKey(t, pack);
    if (!c.ok) {
      if (!blocked.has(k)) {
        log.error(`${t.label}: ${pack.name} を送れません。送り先の ${c.dest} は${c.reason}。`);
        log.info("  消さずに止めました。パックのフォルダ名を変えるか、そのフォルダを自分で別の場所へ移してから、もう一度送ってください");
      }
      blocked.add(k);
      continue;
    }
    blocked.delete(k);
    if (c.adopted) log.info(color.gray(`${t.label}: ${pack.name} は同じパックの古い写しなので、入れ直します`));
    if (clean) rmrf(c.dest);
    for (const f of files) copyIfChanged(f, path.join(c.dest, path.relative(src, f)));
    fs.writeFileSync(path.join(c.dest, MARK_FILE), JSON.stringify({ kit: "bedrock-creator-kit", uuid: pack.manifest.header.uuid, project: project.root }, null, 2));
  }
}

export function describeTargets(targets) {
  for (const t of targets) {
    if (!t.root) log.warn(`送り先 ${t.label}: フォルダが見つからないので飛ばします`);
    else log.info(`送り先 ${color.bold(t.label)}${t.engine ? `（${t.engine.join(".")}）` : ""} → ${t.root}`);
  }
}

// 1 回だけビルドして送る
export async function build(project, { mode = "dev", deploy = true, only } = {}) {
  const targets = deploy ? resolveTargets(project, only) : [];
  if (deploy) describeTargets(targets);
  const stage = stageDir(project, mode);
  rmrf(stage);
  const excluded = makeExcluder(project);
  let ok = true;
  for (const pack of project.packs) {
    const n = stageStatic(project, mode, pack, excluded);
    const sOk = await bundleScript(project, mode, pack);
    ok &&= sOk;
    log.ok(`${pack.kind.toUpperCase()} ${pack.name}（ファイル ${n} 個${pack.script ? (sOk ? "＋スクリプト" : color.red(" スクリプト失敗")) : ""}）`);
  }
  if (deploy) {
    for (const pack of project.packs) deployPack(project, mode, pack, targets);
    for (const t of targets) if (t.root) registerPacksOnBds(t, project.packs);
    const stopped = project.packs.filter((p) => targets.some((t) => t.root && isBlocked(t, p)));
    if (stopped.length) { ok = false; log.warn(`送れなかったパック: ${stopped.map((p) => p.name).join(", ")}`); }
    if (targets.some((t) => t.root)) log.ok(`送りました（${targets.filter((t) => t.root).map((t) => t.label).join("・")}）${stopped.length ? "（上のパックを除く）" : ""}`);
  }
  return { ok, targets, stage };
}

// 見張り（npm run watch）
export async function watch(project, { only } = {}) {
  const mode = "dev";
  log.step(`${color.bold(project.name)} の見張りを始めます（終わるときは Ctrl+C）`);
  let { targets } = await build(project, { mode, deploy: true, only });
  const excluded = makeExcluder(project);

  const queue = new Map();
  let timer = null;
  let busy = false;

  // 型チェックは裏で回し、件数が変わったときだけ知らせる（ビルドは止めない）
  const tsconfig = path.join(project.root, "tsconfig.json");
  let tscRunning = false, tscAgain = false, lastTypeErrors = 0;
  const typesInBackground = () => {
    if (project.config.watchTypes === false || !fs.existsSync(tsconfig)) return;
    if (tscRunning) { tscAgain = true; return; }
    tscRunning = true;
    const child = spawn(process.execPath, [nodeBin("typescript/bin/tsc"), "-p", tsconfig, "--noEmit", "--pretty", "false"], { cwd: project.root });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      tscRunning = false;
      const lines = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
      if (lines.length) {
        log.warn(`型のエラー ${lines.length} 件（ゲームには送っています）`);
        for (const l of lines.slice(0, 5)) console.log(color.gray(`      ${l}`));
        if (lines.length > 5) console.log(color.gray(`      ほか ${lines.length - 5} 件は npm run check で`));
      } else if (lastTypeErrors) log.ok("型のエラーがなくなりました");
      lastTypeErrors = lines.length;
      if (tscAgain) { tscAgain = false; typesInBackground(); }
    });
  };
  typesInBackground();

  const packOf = (file) => {
    const rel = toPosix(path.relative(project.root, file));
    const [dirName, name, ...rest] = rel.split("/");
    const pack = project.packs.find((p) => p.dirName === dirName && p.name === name);
    return { pack, rel: rest.join("/"), dirName, name };
  };

  const flush = async () => {
    if (busy) { timer = setTimeout(flush, 100); return; }
    busy = true;
    const events = [...queue.entries()];
    queue.clear();
    const scriptPacks = new Set();
    let reloadAll = false;
    for (const [file, ev] of events) {
      const { pack, rel, name } = packOf(file);
      if (!pack) { if (name) reloadAll = true; continue; }
      if (rel === "manifest.json") reloadAll = true;
      if (pack.script?.source && rel.split("/")[0] === pack.script.rootDir) { scriptPacks.add(pack); continue; }
      if (excluded(rel)) continue;
      const stageFile = path.join(stagePackDir(project, mode, pack), rel);
      if (ev === "unlink" || ev === "unlinkDir") {
        rmrf(stageFile);
        for (const t of targets) if (t.root && !isBlocked(t, pack)) rmrf(path.join(packDestRoot(t, pack.kind), pack.name, rel));
        log.info(`${color.yellow("削除")} ${pack.name}/${rel}`);
      } else if (ev === "add" || ev === "change") {
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
        copyIfChanged(file, stageFile);
        let sent = false;
        for (const t of targets) if (t.root && !isBlocked(t, pack)) sent = copyIfChanged(file, path.join(packDestRoot(t, pack.kind), pack.name, rel)) || sent;
        if (sent) log.info(`${color.green("更新")} ${pack.name}/${rel}`);
      }
    }
    if (reloadAll) {
      log.step("パックの構成か manifest が変わったので、全体を作り直します");
      try {
        const fresh = loadProject(project.root);
        project.packs = fresh.packs;
        ({ targets } = await build(project, { mode, deploy: true, only }));
      } catch (e) {
        log.error(e.message);
      }
    } else {
      for (const pack of scriptPacks) {
        const t0 = Date.now();
        if (await bundleScript(project, mode, pack)) {
          deployPack(project, mode, pack, targets, { clean: false });
          log.info(`${color.green("スクリプト")} ${pack.name}（${Date.now() - t0}ms）`);
        }
      }
      if (scriptPacks.size) typesInBackground();
    }
    busy = false;
  };

  const watcher = gulp.watch(["behavior_packs/**/*", "resource_packs/**/*", "skin_packs/**/*"], {
    cwd: project.root,
    ignoreInitial: true,
    ignored: ["**/node_modules/**"],
    events: "all",
  });
  watcher.on("all", (ev, file) => {
    queue.set(path.resolve(project.root, file), ev);
    clearTimeout(timer);
    timer = setTimeout(flush, 120);
  });
  log.info(color.gray("ゲーム内で /reload を打つと、スクリプトが読み直されます"));
  return new Promise(() => {});
}
