// チェック（型・ESLint・送り先の版・UUID の重複）
import fs from "node:fs";
import path from "node:path";
import { log, color, run, runCapture, nodeBin, walk, readJson, KIT_ROOT } from "./util.mjs";
import { findWorkspace, loadSettings } from "./settings.mjs";
import { addonsOf, loosePacks } from "./project.mjs";
import { resolveTargets } from "./targets.mjs";
import { checkManifestOnTarget, checkTypesVsManifest } from "./compat.mjs";

const hasScripts = (project) => project.packs.some((p) => p.script?.source);

export function typecheck(project, { strict = false } = {}) {
  const tsconfig = path.join(project.root, "tsconfig.json");
  if (!fs.existsSync(tsconfig) || !project.packs.some((p) => p.script?.source?.endsWith("ts"))) {
    log.info("型チェック: TypeScript のスクリプトがないので飛ばします");
    return { errors: 0 };
  }
  const args = [nodeBin("typescript/bin/tsc"), "-p", tsconfig, "--noEmit", "--pretty"];
  if (strict) args.push("--strict");
  log.step(strict ? "型チェック（strict を仮に ON にして数える）" : "型チェック（tsc）");
  const r = runCapture(process.execPath, args, { cwd: project.root });
  const out = (r.stdout + r.stderr).trim();
  // --pretty の出力には色の記号が混じるので、外してから数える
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  const count = (plain.match(/error TS\d+/g) ?? []).length;
  if (!count && r.status !== 0) {
    console.log(out);
    log.error("型チェックが正しく動きませんでした（上の出力を確認）");
    return { errors: 1 };
  }
  if (count) {
    console.log(out.split("\n").slice(0, strict ? 40 : 200).join("\n"));
    if (strict) log.warn(`strict にすると ${count} 件のエラーになります（直すまで strict は OFF のまま）`);
    else log.error(`型のエラー ${count} 件`);
  } else log.ok("型のエラーなし");
  return { errors: strict ? 0 : count, strictErrors: strict ? count : undefined };
}

export function lint(project, { fix = false } = {}) {
  if (!hasScripts(project)) {
    log.info("ESLint: スクリプトがないので飛ばします");
    return { errors: 0, warnings: 0 };
  }
  const cfg = path.join(project.root, "eslint.config.mjs");
  log.step("ESLint（Mojang のルール込み）");
  const args = [nodeBin("eslint/bin/eslint.js"), "--format", "json", "--no-warn-ignored"];
  if (fs.existsSync(cfg)) args.push("--config", cfg);
  else args.push("--config", path.join(KIT_ROOT, "eslint.base.mjs"));
  if (fix) args.push("--fix");
  args.push("behavior_packs/**/*.{ts,js,mjs}");
  const r = runCapture(process.execPath, args, { cwd: project.root });
  let results;
  try {
    results = JSON.parse(r.stdout);
  } catch {
    console.log(r.stdout + r.stderr);
    log.error("ESLint が動きませんでした");
    return { errors: 1, warnings: 0 };
  }
  let errors = 0, warnings = 0;
  for (const f of results) {
    if (!f.messages.length) continue;
    console.log(color.bold(path.relative(project.root, f.filePath)));
    for (const m of f.messages) {
      const tag = m.severity === 2 ? color.red("エラー") : color.yellow("注意");
      console.log(`  ${m.line}:${m.column}  ${tag}  ${m.message}  ${color.gray(m.ruleId ?? "")}`);
      if (m.severity === 2) errors++; else warnings++;
    }
  }
  if (errors) log.error(`ESLint: エラー ${errors} 件、注意 ${warnings} 件`);
  else if (warnings) log.warn(`ESLint: 注意 ${warnings} 件`);
  else log.ok("ESLint: 指摘なし");
  return { errors, warnings };
}

export function compat(project, { only } = {}) {
  log.step("送り先のゲームで動くか（版のチェック）");
  const targets = resolveTargets(project, only);
  let errors = 0;
  for (const t of targets) {
    const label = `${t.label}${t.engine ? `（${t.engine.join(".")}）` : ""}`;
    const problems = [];
    for (const p of project.packs) for (const x of checkManifestOnTarget(p, t)) problems.push({ ...x, pack: p.name });
    const errs = problems.filter((x) => x.level === "error");
    errors += errs.length;
    if (!problems.length) log.ok(`${label}: 問題なし`);
    else {
      (errs.length ? log.error : log.ok)(`${label}: ${errs.length ? `${errs.length} 件の問題` : "問題なし"}`);
      for (const x of problems) {
        const tag = x.level === "error" ? color.red("  ✖") : x.level === "warn" ? color.yellow("  ⚠") : color.gray("  ・");
        console.log(`${tag} ${x.pack}: ${x.msg}`);
      }
    }
  }
  for (const p of project.packs) for (const x of checkTypesVsManifest(project, p)) log.warn(`${p.name}: ${x.msg}`);
  return { errors };
}

// development 以下と、追加で登録した場所の manifest をすべて見て、UUID の重複を探す
export function scanUuids({ extraRoots = [] } = {}) {
  const ws = findWorkspace();
  const roots = [...(ws ? [ws] : []), ...extraRoots].filter((r) => fs.existsSync(r));
  const map = new Map();
  for (const root of roots) {
    const files = walk(root, {
      skip: (full, ent) =>
        ent.isDirectory() &&
        (["node_modules", ".git", ".bkit", "dist", "_toolkit", "_Template", ".cache"].includes(ent.name) ||
          /backup|バックアップ/i.test(ent.name) ||
          fs.existsSync(path.join(full, "bedrock_server.exe")) || // BDS 一式（バニラのパックが入っている）
          fs.existsSync(path.join(full, "bedrock_server"))),
    }).filter((f) => path.basename(f) === "manifest.json");
    for (const f of files) {
      let m;
      try { m = readJson(f); } catch { continue; }
      if (!m?.header?.uuid) continue;
      const add = (uuid, what) => {
        if (!uuid) return;
        const k = uuid.toLowerCase();
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ file: f, what });
      };
      add(m.header.uuid, "header");
      for (const mod of m.modules ?? []) add(mod.uuid, `module:${mod.type}`);
    }
  }
  // 同じ名前のフォルダ同士（同じパックの写し）は衝突とみなさない
  const dups = [...map.entries()].filter(([, v]) => new Set(v.map((x) => path.basename(path.dirname(x.file)).toLowerCase())).size > 1);
  return dups;
}

export function uuidReport(project, { quiet = false } = {}) {
  if (!quiet) log.step("UUID の重複（ワークスペースの中すべて）");
  const extra = loadSettings().extraRoots ?? [];
  const base = findWorkspace() ?? process.cwd();
  const dups = scanUuids({ extraRoots: extra });
  const mine = project ? dups.filter(([, v]) => v.some((x) => x.file.startsWith(project.root + path.sep))) : dups;
  if (!mine.length) {
    if (!quiet) log.ok(project ? "このプロジェクトの UUID は重複なし" : "UUID の重複なし");
    return { errors: 0, dups: mine };
  }
  for (const [uuid, v] of mine) {
    log.error(`UUID ${uuid} が ${v.length} か所で使われています`);
    for (const x of v) console.log(`    ${x.what.padEnd(14)} ${path.relative(base, x.file)}`);
  }
  log.info("同じワールドに両方を入れると、片方しか読み込まれません。bkit uuid --fix で新しい UUID に振り直せます");
  return { errors: mine.length, dups: mine };
}


// addon.config.json の addons の書き間違い
export function addonsCheck(project) {
  if (!Array.isArray(project.config.addons)) return { errors: 0 };
  log.step("アドオンの組（addon.config.json の addons）");
  let errors = 0;
  const ids = new Set(project.config.addons.map((a) => a.id));
  for (const a of addonsOf(project)) {
    for (const n of a.missing ?? []) { log.error(`${a.id}: パック ${n} が見つかりません`); errors++; }
    for (const r of a.requires) if (!ids.has(r)) { log.error(`${a.id}: 依存先のアドオン ${r} がありません`); errors++; }
    if (!a.packs.length) log.warn(`${a.id}: パックが 1 つもありません`);
  }
  for (const p of loosePacks(project)) log.warn(`${p.name} はどのアドオンにも入っていません（配布ファイルに入らない）`);
  if (!errors) log.ok(`アドオン ${project.config.addons.length} 個: ${project.config.addons.map((a) => a.id).join("・")}`);
  return { errors };
}

export function checkAll(project, opts = {}) {
  const t = typecheck(project);
  const l = lint(project);
  const c = compat(project, opts);
  const u = uuidReport(project);
  const a = addonsCheck(project);
  const errors = t.errors + l.errors + c.errors + u.errors + a.errors;
  console.log("");
  if (errors) log.error(`チェック: 問題 ${errors} 件`);
  else log.ok("チェック: すべて通りました");
  return { errors };
}

export { run };
