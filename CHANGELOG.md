# 更新履歴

## 0.11.0

- 新しい bkit が出ると、bkit を動かしたときに「新しい bkit 〇〇 が出ています。bkit update で新しくできます」と 1 行で知らせる。npm の最新版は 1 日に 1 回、裏の別のプロセスで調べるので、コマンドは待たされない。`bkit doctor` にも npm の最新版を出す。止めるときは環境変数 `BKIT_NO_UPDATE_CHECK=1`
  - この版から入るので、0.10.0 以前を使っている人には届かない
- `npm run release` の形式を選べるようにした: `.mcaddon`（パックを 1 つにまとめる）・`.mcpack`（パックごとに 1 つ。`dist\<名前>_v<版>\` の中）・`.zip`（中身は .mcaddon と同じ）。`--format mcpack` のように指定し、`mcaddon,zip` と並べると両方作る。いつも同じ形式なら `addon.config.json` に `"release": { "format": "zip" }`。メニューの「配布・納品用のファイルを作る」でも選べる
  - 作るのは選んだ形式だけになった。何も選ばなければ `.mcaddon` だけ（前は、いつも `.mcaddon` とパックごとの `.mcpack` の両方を作っていた）
- `bkit new` は、Claude 向けの説明 `CLAUDE.md` を、ふだんは作らなくなった。`bkit setup` で「Claude Code を使う」と答えた PC だけ作る（設定の `claudeMd`）。1 回だけなら `--claude-md`、作らないなら `--no-claude-md`。今ある `CLAUDE.md` は消さず、`bkit upgrade` と `bkit migrate` は今までどおり bkit の節を書き直す。bkit の節に `--format` と `--brarchive` を足した
- README に「新しくするには」（`bkit update` と、手で上げるときのコマンド）を足した
- `npm run build` でゲームに送るとき、パックのフォルダを丸ごと消して作り直すのをやめた。変わったファイルを上書きし、前の版の残りだけ消す。ゲームを開いたままでも送れる（前は、開いていると消したフォルダが「消しかけ」のまま残り、ゲームを終了するまで送れなくなった）。消しかけのフォルダに当たったときは、そう知らせて止める
- Node 24（Windows）で、日本語の名前のファイルを 1 つ消すとプロセスごと落ちる（`fs.rmSync`）のを避けた（`npm run watch` でそのファイルを消したときに起きた）

## 0.10.0

- `npm run release -- --brarchive`: 配布ファイルのパックの中身を `.brarchive` にまとめる（Mojang の公式のパックと同じ `__brarchive\` の形）。いつもまとめるなら `addon.config.json` に `"release": { "brarchive": true }`。メニューの「配布・納品用のファイルを作る」でも選べる
  - どのファイルをまとめ、どれをばらで残すかは、Windows 版 BDS 1.26.61 の PackOptimizer の出力に合わせた。JSON は空白とコメントを抜くだけで、数や文字列の書き方は変えない
  - 統合版のゲームと BDS で、スクリプト・ブロック・テクスチャ・モデルが読み込まれることを確かめた。教育版はまだ試していない
  - スキンパックはまとめない。`npm run watch` でゲームに送るときは、今までどおりばらのまま
- 使える環境の書き方を「Windows 11（Windows 10 では試していません）」に直した

## 0.9.0（ベータ・最初の公開）

- `bkit` だけで出る対話式メニュー。`bkit new`（新しく作る）と `bkit add`（今のプロジェクトにアドオンを足す）は質問に答えるだけ
- ビヘイビアーパック・リソースパック・スキンパックを作れる。manifest は BP / RP が format_version 3、スキンパックが 1
- 送り先: 統合版・Preview・教育版・教育版 Preview・BDS。同時に複数に送れる
- `npm run watch`: 変わったファイルだけ送る。スクリプトは esbuild で 1 本にまとめ、裏で型チェックも回す
- `npm run check`: 型・ESLint（Mojang のルール込み）・送り先のゲームで動く API の版・UUID の重複
- `npm run validate`: Minecraft Creator Tools（Mojang）で検証
- `npm run release`: 版を上げて `.mcaddon` を作る。1 つのプロジェクトに複数のアドオンがあれば、アドオンごとに別のファイル・別の版
- 送るときは、bkit が送ったパックのフォルダにだけ目印（`.bkit.json`）を置き、目印も同じ UUID もない同名のフォルダは消さずに止める
- デバッガ（VS Code 系のエディタで F5）の設定を自動で作る
