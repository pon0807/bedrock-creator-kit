// 新しい bkit が出ているかを知らせる
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { setupEnv, KIT_ROOT } from "./helpers.mjs";

const env = setupEnv();
after(() => env.cleanup());
const { isNewer, updateNotice, refreshInBackground } = await import("../lib/updates.mjs");

test("版の比べ方: 新しい正式な版だけを知らせる", () => {
  assert.equal(isNewer("0.11.0", "0.10.0"), true);
  assert.equal(isNewer("0.10.1", "0.10.0"), true);
  assert.equal(isNewer("1.0.0", "0.10.0"), true);
  assert.equal(isNewer("0.10.0", "0.10.0"), false);
  assert.equal(isNewer("0.9.0", "0.10.0"), false, "数で比べる（文字で比べると 0.9 のほうが大きくなる）");
  assert.equal(isNewer("0.11.0-beta.1", "0.10.0"), false, "ベータは知らせない");
  assert.equal(isNewer("0.10.0", "0.10.0-beta.2"), true);
  assert.equal(isNewer(undefined, "0.10.0"), false);
});

test("知らせる文: 新しい版があるときだけ", () => {
  assert.equal(updateNotice("0.10.0", {}), null);
  assert.equal(updateNotice("0.10.0", { latest: "0.10.0" }), null);
  const msg = updateNotice("0.10.0", { latest: "0.11.0" });
  assert.match(msg, /0\.11\.0/);
  assert.match(msg, /今は 0\.10\.0/);
});

test("裏で調べるのは 1 日に 1 回", () => {
  const file = path.join(env.tmp, "fresh.json");
  assert.equal(refreshInBackground(file, { checked: Date.now(), latest: "0.10.0" }), false);
});

// 裏のプロセスの本体を、偽の npm（手元の HTTP）に向けて動かす
async function runWorker(file, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/bedrock-creator-kit/latest`;
  // spawnSync だとこのプロセスの HTTP が止まるので、非同期で待つ
  const { spawn } = await import("node:child_process");
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(KIT_ROOT, "lib", "update-check-worker.mjs"), file], { env: { ...process.env, BKIT_UPDATE_URL: url }, stdio: "ignore" });
    child.on("close", resolve);
  });
  server.close();
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("裏のプロセス: npm の最新版を調べて書いておく", async () => {
  const file = path.join(env.tmp, "u1", "update-check.json");
  const st = await runWorker(file, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "bedrock-creator-kit", version: "0.12.3" }));
  });
  assert.equal(st.latest, "0.12.3");
  assert.ok(Date.now() - st.checked < 60_000);
});

test("裏のプロセス: 調べられなかったら前の結果を残し、1 時間後にもう一度", async () => {
  const file = path.join(env.tmp, "u2.json");
  fs.writeFileSync(file, JSON.stringify({ checked: 0, latest: "0.10.5" }));
  const st = await runWorker(file, (req, res) => { res.statusCode = 503; res.end(); });
  assert.equal(st.latest, "0.10.5");
  const left = 24 * 60 * 60 * 1000 - (Date.now() - st.checked);
  assert.ok(left > 50 * 60 * 1000 && left <= 60 * 60 * 1000, `次まで ${Math.round(left / 60000)} 分`);
});

test("bkit doctor が npm の最新版を出す", () => {
  const file = path.join(env.tmp, "u3.json");
  fs.writeFileSync(file, JSON.stringify({ checked: Date.now(), latest: "99.0.0" }));
  const r = spawnSync(process.execPath, [path.join(KIT_ROOT, "bin", "bkit.mjs"), "doctor"], { cwd: env.tmp, env: { ...process.env, BKIT_UPDATE_FILE: file }, encoding: "utf8" });
  assert.match(r.stdout, /npm の最新版は 99\.0\.0/);
});
