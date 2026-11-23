// 新しい bkit が出ているかを知らせる
//   - npm の最新版は 1 日に 1 回、裏の別のプロセスで調べ、結果を設定のフォルダに書いておく
//   - コマンドを動かすときは、書いておいた結果を読むだけ（待たない・ネットに出ない）
//   - 止めるときは環境変数 BKIT_NO_UPDATE_CHECK=1（BKIT_OFFLINE や CI のときも調べない）
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { color, parseVersion, cmpNums, KIT_ROOT } from "./util.mjs";
import { SETTINGS_FILE } from "./settings.mjs";

const DAY = 24 * 60 * 60 * 1000;
export const UPDATE_FILE = process.env.BKIT_UPDATE_FILE ?? path.join(path.dirname(SETTINGS_FILE), "update-check.json");

// latest が current より新しいか（latest がベータなどの -付きの版なら知らせない）
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b || a.pre) return false;
  const c = cmpNums(a.nums, b.nums);
  return c > 0 || (c === 0 && !!b.pre);
}

export function readUpdateState(file = UPDATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export const updateCheckDisabled = () => !!(process.env.BKIT_NO_UPDATE_CHECK || process.env.BKIT_OFFLINE || process.env.CI);

// 知らせる文。新しい版がなければ null
export function updateNotice(current, state = readUpdateState()) {
  if (!state.latest || !isNewer(state.latest, current)) return null;
  const how = fs.existsSync(path.join(KIT_ROOT, ".git")) ? "git pull" : "bkit update";
  return `${color.yellow("⬆")} 新しい bkit ${color.bold(state.latest)} が出ています（今は ${current}）。${color.bold(how)} で新しくできます`;
}

// 前に調べてから 1 日たっていたら、裏で調べ直す（このコマンドの終わりを待たせない）
export function refreshInBackground(file = UPDATE_FILE, state = readUpdateState(file)) {
  if (state.checked && Date.now() - state.checked < DAY) return false;
  try {
    const child = spawn(process.execPath, [path.join(KIT_ROOT, "lib", "update-check-worker.mjs"), file], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// コマンドの始めに呼ぶ
export function checkForUpdate(current) {
  if (updateCheckDisabled()) return;
  const state = readUpdateState();
  const msg = updateNotice(current, state);
  if (msg && process.stdout.isTTY) console.log(msg);
  refreshInBackground(UPDATE_FILE, state);
}
