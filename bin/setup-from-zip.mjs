#!/usr/bin/env node
// zip で配った bkit を PC に入れて、初期設定（bkit setup）まで進める。セットアップ.cmd から呼ばれる
// node の標準の機能だけで動く（この時点では、zip のフォルダに node_modules が無いため）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const q = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const sh = (cmd, args, opts = {}) => spawnSync([cmd, ...args.map(q)].join(" "), { shell: true, encoding: "utf8", ...opts });

console.log("\n==== bkit（bedrock-creator-kit）のセットアップ ====\n");

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.log(`Node.js ${process.version} は古いので、20 以上（https://nodejs.org の LTS）を入れてから、もう一度開いてください。`);
  process.exit(1);
}

// 1. まとめる（npm pack）
console.log("[1/3] bkit をまとめています...");
const pack = sh(npm, ["pack", "--silent"], { cwd: KIT });
const tgzName = pack.stdout.trim().split(/\r?\n/).pop();
const tgz = tgzName ? path.join(KIT, tgzName) : null;
if (pack.status !== 0 || !tgz || !fs.existsSync(tgz)) {
  console.log("まとめるのに失敗しました。");
  console.log(pack.stdout, pack.stderr);
  process.exit(1);
}

// 2. PC に入れる（npm install -g）
console.log("[2/3] bkit をこの PC に入れています（1〜2 分かかります）...");
const inst = sh(npm, ["install", "-g", tgz, "--no-fund", "--no-audit", "--loglevel=error"], { stdio: "inherit" });
if (inst.status !== 0) {
  console.log("\n入れるのに失敗しました。上のメッセージを確認してください。");
  fs.rmSync(tgz, { force: true });
  process.exit(1);
}

// 入れた bkit の場所（新しく入れた直後は PATH が古いことがあるので、npm の場所から直接たどる）
const prefix = sh(npm, ["prefix", "-g"]).stdout.trim();
const cand = isWin ? [path.join(prefix, "bkit.cmd")] : [path.join(prefix, "bin", "bkit")];
const bkit = cand.find((p) => fs.existsSync(p)) ?? "bkit";

// 3. 初期設定（ワークスペースにも、この zip の中身から道具を入れる）
console.log("\n[3/3] 初期設定を始めます\n");
const setup = spawnSync([q(bkit), "setup", ...process.argv.slice(2).map(q)].join(" "), {
  shell: true,
  stdio: "inherit",
  env: { ...process.env, BKIT_KIT_TGZ: tgz },
});
fs.rmSync(tgz, { force: true });
if (setup.status !== 0) {
  console.log("\n初期設定が途中で止まりました。あとで PowerShell で bkit setup と打てば、続きからできます。");
  process.exit(setup.status ?? 1);
}
console.log("\n終わりました。新しい PowerShell を開いて、bkit と打ってください。");
