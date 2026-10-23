// アドオンのフォルダを開くアプリ（エディタ）。PC に入っているものを探し、選んだものを設定に覚える
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runCapture } from "./util.mjs";
import { loadSettings, saveSettings } from "./settings.mjs";

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const PF = process.env.ProgramFiles ?? "C:\\Program Files";

// cli: PATH にあるコマンド / exe: 直接起動するファイル / extensions: 拡張を --install-extension で入れられるか
const KNOWN = [
  { id: "vscode", label: "VS Code", cli: "code", exe: [path.join(LOCAL, "Programs", "Microsoft VS Code", "Code.exe"), path.join(PF, "Microsoft VS Code", "Code.exe")], extensions: true },
  { id: "antigravity-ide", label: "Antigravity IDE", cli: "antigravity-ide", exe: [path.join(LOCAL, "Programs", "Antigravity IDE", "Antigravity IDE.exe")], extensions: true },
  { id: "antigravity", label: "Antigravity", cli: "antigravity", exe: [path.join(LOCAL, "Programs", "Antigravity", "Antigravity.exe")], extensions: true },
  { id: "cursor", label: "Cursor", cli: "cursor", exe: [path.join(LOCAL, "Programs", "cursor", "Cursor.exe")], extensions: true },
  { id: "windsurf", label: "Windsurf", cli: "windsurf", exe: [path.join(LOCAL, "Programs", "Windsurf", "Windsurf.exe")], extensions: true },
  { id: "vscodium", label: "VSCodium", cli: "codium", exe: [path.join(LOCAL, "Programs", "VSCodium", "VSCodium.exe")], extensions: true },
  { id: "explorer", label: "エクスプローラー（フォルダを開くだけ）", cli: null, exe: [], always: true },
];

function onPath(cmd) {
  if (!cmd) return false;
  const r = runCapture(process.platform === "win32" ? "where" : "which", [cmd], { shell: true });
  return r.status === 0;
}

let cache = null;
export function detectEditors() {
  if (cache) return cache;
  cache = [];
  for (const e of KNOWN) {
    const hasCli = onPath(e.cli);
    const exe = e.exe.find((p) => fs.existsSync(p));
    if (e.always || hasCli || exe) cache.push({ ...e, hasCli, exePath: exe ?? null });
  }
  // 設定で足したもの（{ "editors": [{ "id": "...", "label": "...", "command": "C:/.../app.exe" }] }）
  for (const c of loadSettings().editors ?? []) {
    if (c?.command && !cache.some((x) => x.id === c.id)) cache.push({ id: c.id ?? c.label, label: c.label ?? c.id, cli: null, exePath: c.command, hasCli: false, extensions: false, custom: true });
  }
  return cache;
}

export function currentEditor() {
  const id = loadSettings().editor;
  const list = detectEditors();
  return list.find((e) => e.id === id) ?? list.find((e) => e.id !== "explorer") ?? list[0];
}

export function rememberEditor(id) {
  saveSettings({ editor: id });
}

export function openIn(editor, dir) {
  if (!editor) return false;
  if (editor.id === "explorer") {
    spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  if (editor.hasCli) {
    spawn(editor.cli, [dir], { detached: true, stdio: "ignore", shell: true }).unref();
    return true;
  }
  if (editor.exePath) {
    spawn(editor.exePath, [dir], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  return false;
}

// VS Code 系のエディタに拡張を入れる（入れられないエディタは false）
export function installExtension(editor, id) {
  if (!editor?.extensions) return false;
  const cmd = editor.hasCli ? editor.cli : editor.exePath;
  if (!cmd) return false;
  const r = runCapture(editor.hasCli ? cmd : `"${cmd}"`, ["--install-extension", id], { shell: true });
  return r.status === 0;
}

export function listExtensions(editor) {
  if (!editor?.extensions) return "";
  const cmd = editor.hasCli ? editor.cli : editor.exePath ? `"${editor.exePath}"` : null;
  if (!cmd) return "";
  return runCapture(cmd, ["--list-extensions"], { shell: true }).stdout;
}
