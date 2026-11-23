# bkit（bedrock-creator-kit）

**Minecraft 統合版（Bedrock Edition）・教育版のアドオン開発ツール**

雛形づくり、ゲームへの転送、型・書き方・API の版のチェック、Mojang 公式の検証、配布ファイル（.mcaddon）の作成までを、1 つのコマンド `bkit` でできます。迷ったら `bkit` とだけ打てば、メニューから選べます。

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**
> Minecraft の公式の製品ではありません。Mojang・Microsoft の承認を受けたものでも、関係するものでもありません。

> **ベータ版（0.12）です。** 作者の環境と、テスト用の PC で確かめていますが、すべての環境での動作は保証できません。大事なアドオンは、git などで控えをとってから使ってください。

## できること

- **選ぶだけで作れる**: `bkit new` は、名前・パック（ビヘイビアー／リソース／スキン）・送り先・使うモジュールとその版を、質問に答えて選ぶだけ。UUID や manifest は自動で書きます
- **教育版で動かない、を防ぐ**: 送り先のゲームの版ごとに、使える Script API の版を確かめます。教育版は本体より古い版で動いているので、教育版を送り先に入れると、それに合わせた版を選びます
- **保存するとゲームに届く**: `npm run watch` で変更を見張り、変わったファイルだけを送ります。スクリプト（TypeScript）は 1 本にまとめ、npm のライブラリも使えます
- **1 コマンドで配布ファイル**: `npm run release` で、チェック → 公式の検証 → 版上げ → .mcaddon まで。1 つのプロジェクトに複数のアドオン（本体＋追加コンテンツなど）があれば、アドオンごとに別のファイル・別の版になります。`--brarchive` を付けると、公式のパックと同じ `.brarchive` の形にまとめます。形式は `.mcaddon`（パックを 1 つにまとめる）・`.mcpack`（パックごと）・`.zip`（中身は .mcaddon と同じ）から選べます
- そのほか: デバッガ（VS Code 系のエディタで F5）、統合版・Preview・教育版・BDS への同時の転送、Mojang の ESLint ルール、UUID の重複のチェック

## 使える環境

- Windows 11（Windows 10 では試していません）
- [Node.js](https://nodejs.org/) 20 以上（LTS がおすすめ）
- Minecraft: 統合版・統合版 Preview・教育版・教育版 Preview・BDS のどれか（入っているものを自動で見つけます）
- あるとよいもの: VS Code か VS Code 系のエディタ（Cursor、Antigravity IDE など）、git

## 入れ方

```bash
npm install -g bedrock-creator-kit
bkit setup
```

`bkit setup` では、アドオンを置くフォルダ（ワークスペース。既定は `ドキュメント\MinecraftAddons`）、ふだん使うエディタ、エディタに入れる拡張、Claude Code（AI）を使うかを聞かれます。Claude Code を使うと答えた PC だけ、新しいアドオンに Claude 向けの説明（`CLAUDE.md`）を作ります。

### 新しくするには

```bash
bkit update
```

PC に入っている bkit と、ワークスペースに入っている bkit の両方を、npm の最新版にします。アドオンのフォルダで `npm run 〇〇` を打ったときに動くのは、ワークスペースのほうです。なので、`npm install -g` だけで上げると、アドオンのフォルダでは古い版のままになります。手で上げるときは、両方を上げてください。

```bash
npm install -g bedrock-creator-kit@latest
cd <ワークスペースのフォルダ>
npm install -D bedrock-creator-kit@latest
```

- 新しい版が出ると、bkit を動かしたときに「新しい bkit 〇〇 が出ています」と 1 行で知らせます（0.11.0 から）
- 今の版は `bkit doctor` の 1 行目で見られます
- 変わったことは [CHANGELOG.md](CHANGELOG.md) にあります。新しい版で設定ファイルの書き方が変わったときは、そこに書いてあるとおり `bkit upgrade --all` でプロジェクトを揃えます

## 使い方

| やりたいこと | 打つもの |
| --- | --- |
| メニューを出す | `bkit` |
| 新しいアドオンを作る | `bkit new` |
| 今のプロジェクトにアドオンを足す | `bkit add` |
| 書きながらゲームに送り続ける | `npm run watch` |
| まちがいがないか確かめる | `npm run check` |
| 公式の検証にかける | `npm run validate` |
| 配布ファイルを作る | `npm run release`（`-- minor` / `-- major` / `-- none`） |
| 配布ファイルを brarchive の形で作る | `npm run release -- --brarchive` |
| 配布ファイルの形式を選ぶ | `npm run release -- --format mcpack`（`mcaddon` / `mcpack` / `zip`。`mcaddon,zip` のように並べると両方。いつもなら `addon.config.json` に `"release": { "format": "zip" }`） |
| ゲームと使える API の版を見る | `bkit doctor` |
| bkit を新しくする | `bkit update`（新しい版が出ると、bkit を動かしたときに 1 行で知らせます） |

`npm run 〇〇` は、アドオンのフォルダの中で打ちます。すべてのコマンドは `bkit help` で見られます。

### コマンド 1 行で作る例

```bash
bkit new SuperSword --packs bp,rp --targets bedrock,education --modules server,ui --display "すごい剣"
bkit add extra --packs bp,rp --requires main
```

## しくみ

- **ワークスペース**: アドオンを置くフォルダ（`bkit-workspace.json` がある）。`stable\`（統合版・教育版向け）と `preview\` に、アドオンを 1 つずつフォルダで置きます。bkit の部品はワークスペースに 1 回だけ入れ、各アドオンで共有します
- **PC ごとの設定**: `%APPDATA%\bedrock-creator-kit\settings.json`（ワークスペースの場所、エディタ、作者の名前、`CLAUDE.md` を作るか）
- **アドオンの設定**: 各アドオンの `addon.config.json`（送り先 `targets`、プロジェクトの中のアドオンの組 `addons` など）
- **API の版の割り出し**: npm の `@minecraft/server` などの公開記録（例: `2.9.0-beta.1.26.32-stable`）から、ゲームの版ごとに使える版を割り出します。Mojang の公式の対応表ではないので、推定を含みます
- **新しい版のお知らせ**: 1 日に 1 回、裏で npm の最新版を調べ、結果を `%APPDATA%\bedrock-creator-kit\update-check.json` に書いておきます。新しい版があれば、次に bkit を動かしたときに 1 行で知らせます（調べるのを待たせることはありません）。止めるときは環境変数 `BKIT_NO_UPDATE_CHECK=1`
- **配布物**: `dev:` ラベルの付いた文と `debugger` を消します
- **brarchive**: `--brarchive`（いつもなら `addon.config.json` に `"release": { "brarchive": true }`）で、BP・RP の中身をフォルダごとに `__brarchive\〇〇.brarchive` にまとめます。どれをまとめ、どれをばらで残すか（`.lang` や音などは、ばらのまま）は、Windows 版 BDS の PackOptimizer（Mojang）の出力に合わせています。JSON は空白とコメントを抜くだけで、中身は変えません

## 気をつけること

- **ゲームに送るとき、送り先の `development_*_packs\<パックのフォルダ名>` を入れ直します。** bkit が送ったフォルダには目印（`.bkit.json`）を置いていて、目印も同じ UUID もない同じ名前のフォルダ（ほかのアドオン）は、消さずに止めて知らせます
- 中で使っている Minecraft Creator Tools（Mojang）は、プレビュー版です
- **Minecraft の更新について**: ゲームの版と、使える Script API の版は、動かすたびに読み直す（npm の記録は 1 日ごとに取り直す）ので、ふだんのアップデートには自動で追いつきます。ゲームのフォルダの場所や manifest の形式など、Mojang が仕組みを変えたときは bkit の更新が要ります（`bkit update`）
- `.bkit\` と `dist\` は生成物なので、手で直さないでください
- brarchive は、Mojang が公式のパックに使っている形です。自作のアドオンでも読み込まれることを、統合版のゲームと BDS 1.26.61 で確かめています（教育版はまだ試していません）。ただし、Mojang は自作のアドオン向けの機能として説明していません。うまく動かないときは `--brarchive` を付けずに作ってください

## 問い合わせについて

- 不具合や要望は [GitHub の Issues](https://github.com/pon0807/bedrock-creator-kit/issues) へ。個人で作っているので、返事や対応は約束できません
- 使い方の個別のサポートは行っていません

## 作り方について

このツールは、作者が [Claude Code](https://claude.com/claude-code)（Anthropic の AI）と一緒に開発しました。動作は作者が確かめていますが、AI が書いたコードを多く含みます。

## ライセンス

[MIT](LICENSE)。無保証です。このツールを使ったことで起きたことについて、作者は責任を負いません。

Minecraft は Mojang Synergies AB の商標です。

---

## English

**bkit (bedrock-creator-kit)** is a CLI toolkit for developing Minecraft Bedrock Edition and Education Edition add-ons: project scaffolding, live deploy to the game, type / lint / Script API version checks, validation with Mojang's Creator Tools, and `.mcaddon` packaging. Windows and Node.js 20+ only. The UI and messages are in Japanese.

```bash
npm install -g bedrock-creator-kit
bkit setup
bkit          # interactive menu
```

**NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.** This is beta software provided "as is" under the MIT License. Developed with the help of Claude Code (Anthropic's AI).
