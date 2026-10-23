// テストの共通の準備。道具の lib を読み込む「前に」呼ぶ（環境変数は読み込み時に読まれるため）
//   - 一時フォルダにワークスペース・偽のゲーム（統合版 1.26.52 / 教育版 1.26.32）・設定ファイルを作る
//   - npm の版の記録は tests/fixtures/npm（2026-10-23 の写し）を使い、ネットには出ない
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function setupEnv({ games = { bedrock: "1.26.52", education: "1.26.32" } } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bkit-test-"));
  const ws = path.join(tmp, "ws");
  const gamesRoot = path.join(tmp, "games");
  for (const [id, ver] of Object.entries(games)) {
    fs.mkdirSync(path.join(gamesRoot, id), { recursive: true });
    fs.writeFileSync(path.join(gamesRoot, id, "version.txt"), ver);
  }
  fs.mkdirSync(path.join(ws, "stable"), { recursive: true });
  fs.mkdirSync(path.join(ws, "preview"), { recursive: true });
  fs.writeFileSync(path.join(ws, "bkit-workspace.json"), JSON.stringify({ kit: "bedrock-creator-kit" }));
  // ワークスペースの node_modules から道具の設定ファイルが見えるようにする（本番と同じ形）。
  // リンク（ジャンクション）は使わない: 片付けの再帰削除がリンクの先（道具そのもの）に及ぶおそれがあるため
  const kitCopy = path.join(ws, "node_modules", "bedrock-creator-kit");
  for (const f of ["package.json", "tsconfig.base.json", "eslint.base.mjs", "types"]) {
    fs.cpSync(path.join(KIT_ROOT, f), path.join(kitCopy, f), { recursive: true });
  }
  const settings = path.join(tmp, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ workspace: ws, author: "テスト作者", editor: "explorer" }));

  // bkit は今いるフォルダから上にたどってワークスペースを探すので、一時フォルダの中から動かす
  // （道具のフォルダから動かすと、ぽんの本物のワークスペースを見つけてしまう）
  process.chdir(tmp);
  process.env.BKIT_SETTINGS = settings;
  process.env.BKIT_GAMES_ROOT = gamesRoot;
  process.env.BKIT_CACHE_DIR = path.join(KIT_ROOT, "tests", "fixtures", "npm");
  process.env.BKIT_OFFLINE = "1";
  process.env.NO_COLOR = "1";
  const cleanup = () => {
    process.chdir(os.tmpdir()); // 消すフォルダの中にいると Windows では消せない
    const rm = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    try {
      rm();
    } catch {
      // Windows ではウイルス対策などが一時的につかんでいて消せないことがある。終わるときにもう一度試す
      process.on("exit", () => { try { rm(); } catch { /* 一時フォルダなので残ってもよい */ } });
    }
  };
  return { tmp, ws, gamesRoot, settings, cleanup };
}

// 道具のログを黙らせる（テストの出力を見やすくする）
export function quiet() {
  const orig = console.log;
  console.log = () => {};
  return () => { console.log = orig; };
}

export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
