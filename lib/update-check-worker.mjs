// 裏で動く: npm の bkit の最新版を調べて、結果をファイルに書く（lib/updates.mjs から呼ぶ）
//   node update-check-worker.mjs <書き出すファイル>
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
const url = process.env.BKIT_UPDATE_URL ?? "https://registry.npmjs.org/bedrock-creator-kit/latest";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let old = {};
try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* はじめて */ }

let state;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  const { version } = await res.json();
  if (typeof version !== "string") throw new Error("版がない");
  state = { checked: Date.now(), latest: version };
} catch {
  // ネットにつながらないときは、1 時間後にもう一度調べる
  state = { ...old, checked: Date.now() - DAY + HOUR };
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(state));
