// ゲームの版ごとに使える Script API の版を、npm の公開履歴から割り出す
//   例: 2.9.0-beta.1.26.32-stable → 1.26.32 では beta が 2.9.0、stable は 2.8.0 まで
//       2.12.0-rc.1.26.70-preview.20 → 1.26.70 では 2.12.0 が stable になる予定
import fs from "node:fs";
import path from "node:path";
import { KIT_ROOT, runCapture, parseVersion, cmpNums, verStr, log } from "./util.mjs";

// BKIT_CACHE_DIR で置き場所を変えられる（テスト用）
const CACHE_DIR = process.env.BKIT_CACHE_DIR ?? path.join(KIT_ROOT, ".cache", "npm");
const DAY = 24 * 60 * 60 * 1000;

export const NATIVE_MODULES = [
  "@minecraft/server",
  "@minecraft/server-ui",
  "@minecraft/server-net",
  "@minecraft/server-admin",
  "@minecraft/server-gametest",
  "@minecraft/server-editor",
  "@minecraft/server-graphics",
  "@minecraft/debug-utilities",
  "@minecraft/diagnostics",
  "@minecraft/common",
];

export function npmVersions(name, { refresh = false } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name.replace(/[@/]/g, "_") + ".json");
  if (!refresh && fs.existsSync(file) && (process.env.BKIT_OFFLINE || Date.now() - fs.statSync(file).mtimeMs < DAY)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = runCapture(npm, ["view", name, "versions", "--json"], { shell: process.platform === "win32" });
  if (r.status === 0) {
    try {
      const list = JSON.parse(r.stdout);
      fs.writeFileSync(file, JSON.stringify(list));
      return list;
    } catch { /* 下で古いキャッシュを使う */ }
  }
  if (fs.existsSync(file)) {
    log.warn(`${name} の版の一覧を取れなかったので、前回の記録を使います`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return null;
}

function parseTagged(list) {
  const plain = [];
  const betas = []; // { api, engine, channel }
  const rcs = [];
  for (const v of list) {
    let m;
    if ((m = v.match(/^(\d+\.\d+\.\d+)$/))) plain.push(parseVersion(m[1]).nums);
    else if ((m = v.match(/^(\d+\.\d+\.\d+)-beta\.(\d+\.\d+\.\d+)-(stable|preview)/))) betas.push({ api: parseVersion(m[1]).nums, engine: parseVersion(m[2]).nums, channel: m[3] });
    else if ((m = v.match(/^(\d+\.\d+\.\d+)-rc\.(\d+\.\d+\.\d+)-(stable|preview)/))) rcs.push({ api: parseVersion(m[1]).nums, engine: parseVersion(m[2]).nums });
  }
  return { plain, betas, rcs };
}

// engine（[1,26,32] など）で使える stable の上限と beta の版
export function apiFor(moduleName, engine) {
  if (!engine) return null;
  const list = npmVersions(moduleName);
  if (!list) return null;
  const { plain, betas, rcs } = parseTagged(list);
  // 同じ engine の beta（なければ、それより前で一番新しい engine の beta）
  const cands = betas.filter((b) => cmpNums(b.engine, engine) <= 0);
  if (!cands.length) return null;
  cands.sort((a, b) => cmpNums(a.engine, b.engine) || cmpNums(a.api, b.api));
  const top = cands[cands.length - 1];
  const beta = top.api;
  const exact = cmpNums(top.engine, engine) === 0;
  const stableCands = [...plain, ...rcs.filter((r) => cmpNums(r.engine, engine) <= 0).map((r) => r.api)].filter((v) => cmpNums(v, beta) < 0);
  stableCands.sort(cmpNums);
  const stable = stableCands[stableCands.length - 1] ?? null;
  return { stable: stable && verStr(stable), beta: verStr(beta), betaEngine: verStr(top.engine), exact };
}

// manifest の依存が、送り先のゲームで動くか
export function checkManifestOnTarget(pack, target) {
  const problems = [];
  const m = pack.manifest;
  const engine = target.engine;
  if (!engine) {
    problems.push({ level: "warn", msg: `${target.label} の版が分からないので、版のチェックを飛ばしました` });
    return problems;
  }
  const minEng = m.header?.min_engine_version;
  if (minEng) {
    const me = parseVersion(minEng)?.nums;
    if (me && cmpNums(me, engine) > 0) {
      problems.push({ level: "error", msg: `min_engine_version ${verStr(me)} は、${target.label}（${verStr(engine)}）より新しいので読み込まれません` });
    }
  }
  for (const dep of m.dependencies ?? []) {
    if (!dep.module_name) continue;
    const want = parseVersion(dep.version);
    if (!want) continue;
    const api = apiFor(dep.module_name, engine);
    if (!api) {
      problems.push({ level: "warn", msg: `${dep.module_name} の対応表が作れませんでした（${target.label} ${verStr(engine)}）` });
      continue;
    }
    if (want.pre.startsWith("alpha")) {
      problems.push({ level: "warn", msg: `${dep.module_name} ${dep.version}: alpha は npm に記録がないので、動くかを確かめられません（Preview 専用）` });
      continue;
    }
    if (want.pre.startsWith("beta")) {
      if (verStr(want.nums) !== api.beta) {
        problems.push({ level: "error", msg: `${dep.module_name} ${dep.version} は、${target.label}（${verStr(engine)}）では使えません。この版の beta は ${api.beta}-beta、stable は ${api.stable} まで` });
      } else {
        problems.push({ level: "info", msg: `${dep.module_name} ${dep.version}: beta の API（ふつうはワールドの実験的機能「Beta API」が要る。ゲームを更新すると版が変わる）` });
      }
    } else if (api.stable && cmpNums(want.nums, parseVersion(api.stable).nums) > 0) {
      problems.push({ level: "error", msg: `${dep.module_name} ${dep.version} は、${target.label}（${verStr(engine)}）では使えません。stable は ${api.stable} まで` });
    }
    if (!api.exact && target.kind === "game") {
      problems.push({ level: "info", msg: `${dep.module_name}: ${verStr(engine)} の公開記録がないので、${api.betaEngine} の記録から推定しました` });
    }
  }
  return problems;
}

// 型（node_modules）が manifest より新しいと、実行時に無い API を書けてしまう
export function checkTypesVsManifest(project, pack) {
  const problems = [];
  for (const dep of pack.manifest.dependencies ?? []) {
    if (!dep.module_name) continue;
    const pj = path.join(project.root, "node_modules", ...dep.module_name.split("/"), "package.json");
    if (!fs.existsSync(pj)) continue;
    const installed = JSON.parse(fs.readFileSync(pj, "utf8")).version;
    const iv = parseVersion(installed);
    const mv = parseVersion(dep.version);
    if (!iv || !mv) continue;
    const sameMinor = iv.nums[0] === mv.nums[0] && iv.nums[1] === mv.nums[1];
    if (!sameMinor && cmpNums(iv.nums, mv.nums) > 0) {
      problems.push({ level: "warn", msg: `型の ${dep.module_name}@${installed} が manifest の ${dep.version} より新しいです。npm install ${dep.module_name}@${verStr(mv.nums)}${mv.pre ? "-" + mv.pre : ""} で揃えると、使えない API に赤線が出ます` });
    }
  }
  return problems;
}

// 複数の送り先に共通で使える stable の版（新しく作るときに使う）
export function commonStable(moduleName, targets) {
  let min = null;
  for (const t of targets) {
    const api = apiFor(moduleName, t.engine);
    if (!api?.stable) continue;
    const v = parseVersion(api.stable).nums;
    if (!min || cmpNums(v, min) < 0) min = v;
  }
  return min && verStr(min);
}

// ---------- 新しく作るときに選べるモジュールと版 ----------
export const MODULE_INFO = {
  "@minecraft/server": { kind: "module", label: "ワールド・エンティティ・イベントなど（基本）" },
  "@minecraft/server-ui": { kind: "module", label: "フォーム（ボタンや入力の画面）", needs: "@minecraft/server" },
  "@minecraft/server-gametest": { kind: "module", label: "自動テスト（GameTest）", needs: "@minecraft/server" },
  "@minecraft/debug-utilities": { kind: "module", label: "デバッグ用の道具", needs: "@minecraft/server" },
  "@minecraft/server-net": { kind: "module", label: "HTTP 通信", needs: "@minecraft/server", bdsOnly: true },
  "@minecraft/server-admin": { kind: "module", label: "サーバーの管理（変数・秘密の値）", needs: "@minecraft/server", bdsOnly: true },
  "@minecraft/math": { kind: "lib", label: "ベクトル計算のライブラリ" },
  "@minecraft/vanilla-data": { kind: "lib", label: "バニラのブロック・アイテムの ID 一覧" },
};

const plainVersions = (list) => list.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => cmpNums(parseVersion(a).nums, parseVersion(b).nums)).reverse();

// 選べる版の一覧（新しい順）と、おすすめ
export function versionChoices(moduleName, targets) {
  const info = MODULE_INFO[moduleName] ?? { kind: "module" };
  const list = npmVersions(moduleName) ?? [];
  const engines = targets.map((t) => t.engine).filter(Boolean);
  const low = [...engines].sort(cmpNums)[0];
  const options = [];

  if (info.kind === "lib") {
    let plain = plainVersions(list);
    let rec = plain[0];
    if (moduleName === "@minecraft/vanilla-data" && low) {
      // ゲームの版に合わせて出ている（1.26.32 なら 1.26.32 以下で一番新しいもの）
      rec = plain.find((v) => cmpNums(parseVersion(v).nums, low) <= 0) ?? plain[0];
    }
    plain = [rec, ...plain.filter((v) => v !== rec)].slice(0, 8);
    for (const v of plain) options.push({ value: v, label: v, hint: v === rec ? "おすすめ" : "" });
    return { options, recommended: rec };
  }

  // stable: 送り先すべてで動く版まで（ゲームの版が 1 つも分からないときは、公開されている最新の stable）
  const max = engines.length ? commonStable(moduleName, targets) : plainVersions(list)[0] ?? null;
  // stable が無いモジュール（server-net など）は beta だけ
  const stables = max ? plainVersions(list).filter((v) => cmpNums(parseVersion(v).nums, parseVersion(max).nums) <= 0).slice(0, 6) : [];
  for (const v of stables) options.push({ value: v, label: v, hint: v === max ? "おすすめ（送り先すべてで動く最新）" : "" });

  // beta: 送り先ごとに版が決まっている。全部で同じならそれを 1 つ、違えば送り先ごとに出す
  const betas = new Map();
  for (const t of targets) {
    const a = apiFor(moduleName, t.engine);
    if (!a?.beta) continue;
    const v = `${a.beta}-beta`;
    if (!betas.has(v)) betas.set(v, []);
    betas.get(v).push(t.label);
  }
  for (const [v, labels] of betas) {
    const all = labels.length === targets.length;
    options.push({ value: v, label: v, hint: `beta${all ? "" : `・${labels.join("・")}でしか動かない`}・ワールドの「Beta API」が要る` });
  }
  const recommended = max ?? options[0]?.value;
  return { options, recommended };
}
