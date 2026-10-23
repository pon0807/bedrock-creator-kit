# 更新履歴

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
