# vck (vibe-crafting-kintone)

**AppSpec（JSON）1 つで、kintone アプリを何度でも、いくつでも作れる CLI。**

```bash
vck deploy bookshelf.json                    # 作る
vck deploy bookshelf.json --space 12         # 同じものを、別のスペースにもう 1 つ
KINTONE_BASE_URL=https://other.cybozu.com \
  vck deploy bookshelf.json                  # 同じものを、別のドメインにも
```

アプリの形をファイルとして持てるので、レビューでき、差分が見え、
検証環境と本番で同じものを作れる。手で 18 個のフィールドを並べ直す作業が消える。

**その AppSpec は、要件を書いた文章からも作れる。**

```bash
vck plan -f requirements.md -o bookshelf.json
```

こちらは付加価値であって、中心ではない。生成された AppSpec は普通の JSON なので、
気に入らなければ手で直せばよいし、最初から手で書いてもよい。

```
要件 (文章) ──[plan / LLM]──> AppSpec (JSON) ──[deploy]──> kintone
                                    ↑
                            手で書いても、手で直してもよい
```

### deploy は LLM を呼ばない

| コマンド | kintone | Claude |
|---|---|---|
| `deploy` `status` | 触る | **呼ばない** |
| `plan` | 触らない | 呼ぶ |
| `create` | 触る | 呼ぶ（= `plan` + `deploy`） |

同じ AppSpec からは常に同じ API 呼び出しが出る。意味によるフィールドのまとめ方（`group`）
のような判断も、`plan` の時点で AppSpec に書き込まれた**データ**として渡るので、
デプロイ側は判断せずそれを使うだけ。

この境界は `tests/architecture.test.ts` で固定している。

- `src/kintone` `src/spec` `src/icon` が `src/llm` や `@anthropic-ai/sdk` に依存しないこと
- 逆に `src/llm` が `src/kintone` に依存しないこと（両者は CLI が繋ぐ）
- デプロイ経路に乱数が無いこと
- 同じ AppSpec を 2 回デプロイすると、同じ API 呼び出しの列になること

なお、アプリ ID・リビジョン・`fileKey` は kintone が採番するので当然変わる。
決定的なのは「vck が何を送るか」であって、サーバーが返す値ではない。

### 毎回「新しいアプリ」を作る

`deploy` は実行のたびに新しいアプリを作る。**既存アプリの更新はしない。**
同じ spec を 2 回流せば、同じ形のアプリが 2 つできる。

これは「テンプレートから量産する」用途に向く一方、
「デプロイ済みのアプリに変更を反映する」用途には使えない。後者は今後の課題。

## 使い方

```bash
# 1. kintone に認可する（初回のみ）
npm run vck -- login

# 2. 送信予定の内容を確認する（kintone には触らない）
npm run vck -- deploy bookshelf.json --dry-run

# 3. デプロイする
npm run vck -- deploy bookshelf.json

# 反映状況を確認する
npm run vck -- status 752
```

AppSpec を文章から作る場合:

```bash
# 設計だけ作る（kintone には接続しない）
npm run vck -- plan -f requirements.md -o bookshelf.json

# 生成からデプロイまで一気に（デプロイ前に確認が入る）
npm run vck -- create -f requirements.md
```

| コマンド | 説明 |
|---|---|
| `deploy <spec.json>` | AppSpec を kintone にデプロイする |
| `pull <appId>` | 既存アプリを AppSpec として取り出す（読み取りのみ）|
| `diff <appId> <spec.json>` | 既存アプリと AppSpec の差分を表示する（読み取りのみ）|
| `status <appId>` | 運用環境への反映状況を確認する |
| `login` / `logout` | kintone の OAuth トークンの取得・破棄 |
| `schema` | AppSpec の書き方を出力する（AI エージェント向け）|
| `plan [prompt]` | 要件から AppSpec を生成する。`-o` で保存 |
| `create [prompt]` | 生成 → 確認 → デプロイ |

主なオプション: `--dry-run` / `--space <id>` / `--thread <id>` / `--guest-space <id>` /
`--revert-on-failure` / `--model <model>` / `-f` / `-o` / `-y` / `-v` / `--json`

## セットアップ

```bash
npm install
cp .env.example .env   # 値を埋める
```

必要な認証情報は用途で分かれる。**`deploy` だけ使うなら kintone 側だけでよい。**

| 用途 | 設定するもの | 必要なコマンド |
|---|---|---|
| `deploy` `status` | OAuth クライアント（`.env`） | `vck login` |
| `plan` `create` | 上記 + `ANTHROPIC_API_KEY` または `ant auth login` | なし |

### kintone 側の準備

1. cybozu.com 共通管理 → 外部サービス連携 → **OAuth クライアント** でクライアントを登録する。
   リダイレクトエンドポイントには、認可後に転送される URL を指定する
   （vck は転送先の URL を手で貼り付ける方式なので、実際にページが存在しなくても構わない）。
2. 登録すると **クライアント ID / シークレット / 認可エンドポイント URL / トークンエンドポイント URL**
   が払い出されるので、そのまま `.env` に書く。
3. 実行するユーザーに **「アプリの作成」権限** が必要。

必要な OAuth スコープは次の 2 つ。レコードには触れないので、レコード系のスコープは要求しない。

| スコープ | 用途 |
|---|---|
| `k:app_settings:write` | アプリ作成、フィールド追加、一覧・一般設定の変更、運用環境への反映 |
| `k:app_settings:read` | **反映状況の確認**（`GET /k/v1/preview/app/deploy.json`） |
| `k:file:write` | **アプリアイコンの画像アップロード**（`POST /k/v1/file.json`） |

`read` を忘れると、書き込みがすべて成功したあと最後の状況確認だけが
`403 CB_OA01 Cannot access protected resource` で落ちる。
アプリは動作テスト環境に作られたまま残るという分かりにくい壊れ方をするので、
vck は保存済みトークンのスコープを起動時に検査し、足りなければ 1 リクエストも投げずに停止する。

> アプリの新規作成 API（`POST /k/v1/preview/app.json`）は **API トークンでは実行できない**。
> そのため vck は OAuth 認証を使う。

### 認可

```bash
npm run vck -- login
```

表示された URL をブラウザで開いて許可し、転送先のアドレスバーの URL をそのまま貼り付ける。
アクセストークンは 1 時間で失効するが、リフレッシュトークン（無期限）を
`~/.config/vck/tokens.json`（パーミッション 0600）に保存するので、以降の再ログインは基本的に不要。

## AppSpec — アプリの設計図

```jsonc
{
  "name": "案件管理",                    // 64 文字以内
  "description": "営業案件を管理します",  // 10,000 文字以内
  "theme": "BLUE",
  "fields": [                            // 配列の順序がフォームの配置順になる
    { "type": "SINGLE_LINE_TEXT", "label": "案件名", "required": true },
    { "type": "NUMBER", "label": "金額", "digit": true, "unit": "円", "unitPosition": "AFTER" },
    { "type": "DROP_DOWN", "label": "受注確度", "options": ["高", "中", "低"], "defaultValue": "中" },
    { "type": "USER_SELECT", "label": "担当者" },
    { "type": "DATE", "label": "受注予定日" }
  ],
  "views": [
    { "name": "全件", "type": "LIST", "fields": ["案件名", "金額"], "sort": "受注予定日 asc" }
  ],
  "settings": { "titleFieldCode": "案件名", "enableComments": true }
}
```

- **選択肢は文字列の配列**で書く。kintone が要求する `{ ラベル: { label, index } }` への変換は vck が行う。
- `icon` に絵文字か頭文字を書くと、**アイコン画像を生成してアップロードし**、アプリアイコンに設定する。
- `code`（フィールドコード）は省略可。省略すると `label` から導出する。
- `STATUS` / `ASSIGNEE` / `CATEGORY` などフィールド追加 API で追加できない型は、
  **kintone に 1 リクエストも投げる前に**理由付きで弾く。
- 一覧や `titleFieldCode` から参照するフィールドコードの存在も、事前に検証する。

## スペースへの配置

アプリを特定のスペースに作れる。CLI の `--space` が AppSpec の `space` より優先される。

```bash
npm run vck -- deploy spec.json --space 12
```

```jsonc
{
  "name": "案件管理",
  "space": 12,          // スペース ID
  "thread": 34,         // 省略可。kintone がスレッドの指定を求める場合のみ
  "guestSpaceId": 7     // ゲストスペースの場合のみ
}
```

省略するとスペースに属さないアプリになる。

### スペース指定時は REST API を直接叩いている

`@kintone/rest-api-client` の `addApp()` は、スペース指定時にデフォルトスレッドを
調べるため `GET /k/v1/space.json` を呼ぶ。ところが **この API は OAuth 認証に対応していない**
（パスワード認証とセッション認証のみ）ため、OAuth で動く vck からは使えない。

そこでスペース指定時だけ `POST /k/v1/preview/app.json` を直接叩き、`space` を渡している
（`src/kintone/deploy.ts` の `createPreviewApp`）。トークンの更新は通常経路と同じ仕組みに乗る。

kintone がスレッドの指定を求めた場合は `--thread` を使う。スレッド ID はスペースを
開いたときの URL から読める: `/k/#/space/{スペースID}/thread/{スレッドID}`

## フォームのレイアウト

似た系統のフィールドを横に並べる。既定で有効。

```jsonc
{
  "layout": "grouped",                          // 既定。省略してもこの動作
  "layout": { "mode": "grouped", "maxPerRow": 2 }, // 1 行あたりの上限を変える (既定 3)
  "layout": "stacked"                           // レイアウトに触らない (1 行 1 フィールド)
}
```

### 並べ方の規則

**並び順は変えない。** AppSpec に書いた順序のまま、隣り合った同じ系統のフィールドを
最大 `maxPerRow` 個まで同じ行にまとめる。系統が変わったところで行を切る。

| 系統 | フィールド型 |
|---|---|
| テキスト | `SINGLE_LINE_TEXT` `LINK` |
| 数値 | `NUMBER` `CALC` |
| 選択 | `DROP_DOWN` `RADIO_BUTTON` `CHECK_BOX` `MULTI_SELECT` |
| 日時 | `DATE` `TIME` `DATETIME` |
| ユーザー | `USER_SELECT` `ORGANIZATION_SELECT` `GROUP_SELECT` |

`MULTI_LINE_TEXT` `RICH_TEXT` `FILE` など、幅や高さを取る型は常に単独行にする。

18 フィールドの例:

```
bookshelfId | title | author
readStatus | rating | ownership
lentTo | location | tags
publisher
publishedYear
isbn | coverUrl
cover
lookupStatus
spineText
addedOn
memo
```

`deploy --dry-run` でこの並びを事前に確認できる。

### 実物を起点に並べ替えている

レイアウト変更 API は **「フォーム上のすべてのフィールド」の指定を求める**。
1 つでも欠けると失敗するので、AppSpec から推測して組み立てず、
フィールド追加後に `getFormLayout` で **kintone が実際に置いたレイアウトを取得してから**
並べ替えている（`src/spec/layout.ts` の `regroupLayout`）。
`GROUP` と `SUBTABLE` の行は中身の構造が別なので、触らずそのまま残す。

## アプリアイコン

`icon` に絵文字か文字を書くと、256×256 の PNG を生成してアプリアイコンに設定する。

```jsonc
{
  "name": "書籍管理",
  "icon": "📚",              // 絵文字、または "書" のような頭文字
  "iconBackground": "#2563eb" // 省略するとアプリ名から自動で決まる
}
```

省略した場合はアイコンを設定しない（kintone の既定アイコンのまま）。
`plan` / `create` では、モデルが内容に合った絵文字を選ぶ。

### 描画のしくみ

文字と絵文字で経路が分かれる。

| `icon` の内容 | 描き方 |
|---|---|
| `書` `案` `AB` などの文字 | 同梱の **DotGothic16**（ドット絵風の日本語フォント）で描画 |
| `📚` `💼` などの絵文字 | **Noto Color Emoji から PNG を取り出して合成** |

絵文字を `<text>` として描かないのは、Noto Color Emoji が CBDT 形式の
**ビットマップ**フォントで、SVG のラスタライザ（resvg）が描画できないため。
このフォントは絵文字の実体が PNG として埋め込まれているので、
ラスタライズせず取り出してそのまま合成している（`src/icon/emojiFont.ts`）。

- フォントは `assets/fonts/DotGothic16.ttf` に同梱（OFL-1.1、`OFL.txt` 同梱）。
  システムフォントは使わないので、実行環境によって見た目が変わらない。
- 絵文字フォントは環境依存で探す。見つからない場合や、ZWJ で連結した複雑な絵文字は、
  **文字として描画する**（アイコン生成そのものは失敗させない）。
- 同じ入力なら常に同じ画像になる。背景色もアプリ名から決まるので、作り直しても見た目が変わらない。

## 失敗したときの挙動

デプロイは次の順に進む。

1. 動作テスト環境にアプリを作成
2. フィールドを追加（100 件ずつ分割）
3. フォームの並びを整える（`layout` が `grouped` の場合のみ。既定で有効）
4. アイコン画像を生成してアップロード（`icon` の指定がある場合のみ）
5. 一般設定を変更（アイコンまたは他の設定がある場合のみ）
6. 一覧を変更（指定がある場合のみ）
7. 運用環境へ反映（非同期）
8. 反映完了までポーリング（指数バックオフ、最大 5 分）

各ステップが返す `revision` を次の呼び出しに引き回すので、同じアプリを別の誰かが同時に
編集していた場合は kintone 側で検出される。

2 以降で失敗した場合、アプリは**動作テスト環境にだけ存在し、運用環境には出ていない**。
既定では調査できるようにアプリを残し、エラーにアプリ ID を含めて報告する。
破棄したい場合は `--revert-on-failure` を付けて実行する。

## 既存アプリを AppSpec にする

手で作った既存アプリも AppSpec として取り出せる。**読み取りしかしないので、いつ実行しても安全。**

```bash
vck pull 752 -o spec.json
```

取り出した AppSpec はそのまま `deploy` に渡せるので、既存アプリを雛形にして
別のスペースや別のドメインに複製できる。

### 表現できないものは黙って捨てない

AppSpec は kintone の設定をすべて表現できるわけではない。落としたものは必ず知らせる。

```
次の設定は AppSpec で表現できないため含まれていません:
  - フィールド「明細」(SUBTABLE) は AppSpec で表現できないため除きました。
    デプロイし直しても、このフィールドは作られません。
  - アプリアイコンに画像が設定されていますが、AppSpec には含められません。
```

黙って捨てると「取得した spec をデプロイしたら別物ができた」となるので、
`--json` でも `warnings` として返す。

現状で落ちるもの: テーブル・ルックアップ・関連レコード一覧などの未対応フィールド型、
カスタマイズ一覧、アプリアイコンの画像、細かなレイアウト。

### レイアウトについて

`pull` は `"layout": "stacked"` を付けて返す。AppSpec は任意のレイアウトを
表現できないので、**既存の並びに手を触れない**という指定にしてある。
横並びにしたい場合は `"layout": "grouped"` に書き換える。

フィールドの順序は、フォームのレイアウト上の位置から復元する
（`getFormFields` はオブジェクトを返すので順序が保証されない）。

## 差分を見る

手元の AppSpec と既存アプリの違いを表示する。**読み取りのみ。**

```bash
vck diff 761 target.json
```

```
  ~ description: 営業案件の進捗を管理します。 → 営業案件の進捗を管理します（更新版）
  + 受注日 (DATE) を追加
  ~ 受注確度: options: ["高","中","低"] → ["S","A","B","C"]
  ! 備考: 型を MULTI_LINE_TEXT → SINGLE_LINE_TEXT に変更 (kintone では不可)
  - 顧客名 (SINGLE_LINE_TEXT) を削除候補へ
  + 一覧「今月の案件」を追加
```

| 記号 | 意味 |
|---|---|
| `+` | 追加する |
| `~` | 設定を変更する |
| `!` | **kintone では実行できない**（型変更）|
| `-` | 削除候補にする（**削除しない**）|

### 同一性はフィールドコードで決まる

ラベルだけ変えたなら「同じフィールドの変更」、コードが変わったら「別フィールドの追加 + 元は削除候補」。
AppSpec を書き直すときは、**既存フィールドのコードを変えないこと**。

### 型は変更できない

kintone は作成後のフィールド型を変えられない。`!` が出た場合、実現するには
別のコードで新しいフィールドを作り、古い方を削除候補に送ることになる。
**データは移らない。**

### 削除候補という考え方

目標の AppSpec から消えたフィールドを、vck は**削除しない**。
畳んだグループに移すだけで、データは残る。実際に消すかどうかは人が kintone の画面で決める。

## AI エージェントから使う

エージェントの仕事は **AppSpec を書くこと**で、デプロイはシェルコマンド 1 つ。
そのために必要なものは揃えてある。

### 1. 書き方を教える

```bash
vck schema             # 簡潔な一覧（これを読ませる）
vck schema --json      # 完全な JSON Schema
vck schema --example   # そのまま deploy できる実例
```

いずれも Zod の定義から導出しているので、実装とずれない。

### 2. 認証なしで検証させる

```bash
vck deploy spec.json --dry-run --json
```

`--dry-run` は **kintone にも Claude にも接続しない**。
エージェントは「書く → 検証 → 直す」を、資格情報なしで何度でも回せる。

### 3. 結果を機械可読で受け取る

`--json` を付けると、**stdout は JSON だけ**になり、進捗と人間向けの表示は stderr に回る。

```json
{
  "ok": true,
  "command": "deploy",
  "app": { "id": "752", "url": "https://example.cybozu.com/k/752/", "name": "案件管理" },
  "revision": "7",
  "fieldCount": 6
}
```

失敗も同じ形で返る。`hint` に次の一手が入る。

```json
{
  "ok": false,
  "command": "deploy",
  "error": {
    "kind": "validation",
    "exitCode": 2,
    "hint": "AppSpec を直して再実行する",
    "message": "AppSpec の検証に失敗しました",
    "issues": [
      { "path": "fields.0.type", "message": "STATUS: プロセス管理の設定で追加される…" }
    ]
  }
}
```

### 終了コード

全部 1 で返すと「AppSpec を直す」のか「login する」のかが判別できないので、種類ごとに分けてある。

| コード | `kind` | 次にすること |
|---|---|---|
| 0 | — | 成功 |
| 1 | `unknown` | 想定外。メッセージを確認する |
| 2 | `validation` | AppSpec を直して再実行する |
| 3 | `auth` | `vck login` で認可をやり直す |
| 4 | `config` | `.env` の設定を見直す |
| 5 | `kintone` | 権限を確認するか、時間をおいて再試行する |
| 6 | `generation` | 要件の書き方を変えて再実行する |
| 7 | `input` | コマンドの引数を見直す |

### 使い方の型

```bash
vck schema > /tmp/appspec-reference.md   # 1. 書き方を読む
# 2. エージェントが spec.json を書く
vck deploy spec.json --dry-run --json    # 3. 検証（認証不要）。exit 2 なら issues を読んで直す
vck deploy spec.json --json              # 4. デプロイ
```

`login` だけは人間が一度やる必要がある（ブラウザで認可して URL を貼る）。
それ以外はすべて非対話で動く。`create` は確認が入るので、エージェントからは `-y` を付ける。

### MCP ではなく CLI にしている理由

- エージェントの実作業は**ファイルを書くこと**。AppSpec は 100 行を超える JSON で、
  ツール引数に埋めるより、ファイルとして残すほうがレビューでき、差分が見え、再利用できる
- 検証ループ（`--dry-run`）が**資格情報なしで回る**
- デプロイは進捗を出す長時間処理で、stderr へのストリーミングと相性がよい

シェルの無いホストから使いたくなったら、`deployAppSpec` / `generateAppSpec` を包む
薄い MCP サーバーを足せばよい。コアがライブラリとして分離してあるので、後から乗せられる。

## AppSpec を文章から作る

`plan` と `create` は、要件を書いた文章から AppSpec を生成する。
生成結果は必ず AppSpec のスキーマで検証されるので、kintone に無効な設定が届くことはない。

`plan` / `create` を使う場合のみ必要。次のどちらかを設定する。

```bash
# .env に書く（または環境変数として export する）
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
# もしくは Anthropic CLI でログインする（キーをファイルに書かずに済む）
ant auth login
```

どちらも無い場合、`plan` / `create` は次のエラーで停止する。

```
Claude API の認証情報が見つかりません。次のいずれかを設定してください:
  - .env または環境変数に ANTHROPIC_API_KEY を設定する
  - Anthropic CLI (`ant auth login`) でログインする
```

### 要件をファイルから渡す

要件が長くなると、シェルの引数として渡すのは現実的でなくなる（改行、引用符、全角括弧）。
`--prompt-file`（`-f`）でファイルから読める。Markdown でも構わない。

```bash
npm run vck -- plan -f requirements.md -o spec.json
npm run vck -- create -f requirements.md
```

`-` を渡すと標準入力から読む。

```bash
cat requirements.md | npm run vck -- plan -f - -o spec.json
```

引数と `--prompt-file` の同時指定はエラーにする。どちらが使われるか曖昧なまま
生成が走るほうが困るため。どちらも無い場合は使い方を表示する。

## 実行中の見え方

生成もデプロイも数十秒かかることがあるので、何をしているかを常に表示する。
生成はストリーミングで行うため、待っている間も進み具合が動く。

```
⠹ 設計を書き出しています (612 文字) (14秒)
```

完了すると 1 行に確定する。

```
✓ 設計を生成しました (23 秒, 入力 1243 / 出力 892 トークン)
```

### `--verbose`

`-v` / `--verbose` を付けると、切り分けに要る情報まで出す。

- 生成中の**思考の要約**（いま何を考えているかが流れる）
- 使用モデル、接続先の kintone ドメイン
- 各ステップの `revision` の遷移、追加したフィールドコード
- 反映状況の確認が何回目か、何秒経過したか

```bash
npm run vck -- --verbose create "問い合わせ管理アプリ"
```

```
⠸ 考え中: …問い合わせの状態は「未対応/対応中/完了」の3つが妥当 (8秒)
✓ 設計を生成しました (23 秒, 入力 1243 / 出力 892 トークン)

「問い合わせ管理」をデプロイします (フィールド 6 件)
  アプリ「問い合わせ管理」を動作テスト環境に作成します
  アプリ ID 128 を作成しました
    revision=1
  フィールドを 6 件追加します
  フィールドを追加しました
    件名, 内容, 対応状況, 担当者, 受付日, 備考 / revision 1 → 2
  運用環境へ反映します
    POST /k/v1/preview/app/deploy.json (app=128, revision=4)
  反映の完了を待っています
  反映状況: PROCESSING
    1 回目の確認 (1 秒経過)
  反映状況: SUCCESS
    2 回目の確認 (3 秒経過)

✓ デプロイが完了しました。
```

### 応答が来ないとき

`サーバーの応答を待っています (NN 秒経過 / 上限 180 秒)` のままカウントが進む場合、
リクエストは送信済みでサーバーからの最初の応答を待っている状態を意味する。
180 秒で打ち切り、確認すべきことを添えて終了する（SDK の既定は 10 分だが、
CLI がそれだけ無反応だと事故と区別が付かないので短くしてある）。

原因の切り分けには `--verbose` を使う。サーバーから届いた生のイベントが
到着順に表示されるので、どこで止まっているかが分かる。

```
  リクエスト ID: req_011Ce...
  イベント: message_start (2 秒)
  イベント: content_block_start (2 秒)
  イベント: content_block_delta (3 秒)
```

`リクエスト ID` は問い合わせの際に使える。

進捗は stderr に出すので、`plan` の JSON を `>` でファイルに落としても混ざらない。
パイプやリダイレクト時は 1 行書き換えをやめ、普通の行として出す（ANSI エスケープを混ぜない）。

## 開発

```bash
npm run typecheck
npm test              # ユニットテスト（kintone にも Claude にも接続しない）
npm run e2e:manual    # 実 kintone 環境に検証用アプリを 1 つ作る
```

ユニットテストは kintone REST API を MSW でモックし、実際に飛ぶ HTTP を観測して
呼び出し順序・`revision` の引き回し・分割・ポーリング・失敗時の挙動まで検証している。

### 構成

| パス | 役割 |
|---|---|
| `src/spec/` | AppSpec のスキーマ（Zod）と kintone ペイロードへの変換 |
| `src/kintone/` | OAuth、トークン保存、クライアント、デプロイのオーケストレーション |
| `src/icon/` | アプリアイコンの生成（SVG → PNG、絵文字の抽出） |
| `src/llm/` | プロンプト → AppSpec の生成（Claude API） |
| `src/cli/` | コマンド定義 |

### 構造化出力のスキーマに関する制約

`src/llm/generate.ts` の LLM 向けスキーマは、**すべてのプロパティを必須にし、
「指定なし」を空文字・空配列で表す**。見た目は不自然だが、これには理由がある。

構造化出力には 2 つの上限があり、素直に書くとどちらかに必ず当たる。

| 書き方 | 生成される JSON Schema | 当たる上限 |
|---|---|---|
| `.nullable()` | `anyOf: [T, null]` = union | 「union を持つパラメータは 16 個まで」 |
| `.optional()` | `required` から外れる | キーの出現順が自由になり grammar が膨張 →「Schema is too complex」 |

どちらも実際に `400` で弾かれた。すべて必須にすれば union も省略可も 0 になり、
grammar が最小になる。空の値は `toAppSpecInput()` で落とすので、コア側には現れない。
この不変条件（union 0 / 省略可 0 / プロパティ 16 個以下）は `tests/llm.test.ts` で見張っている。

それでもスキーマが弾かれた場合は、**構造化出力を使わず JSON を直接書かせる方式に自動で切り替える**。
どちらの経路でも結果は必ずコアの `parseAppSpec()` で検証するので、扱いは変わらない。

LLM 層は `zod/v4`（`@anthropic-ai/sdk` の `zodOutputFormat` が要求）、
コアは zod v3 を使う。両者の値は直接やり取りせず、`toAppSpecInput()` で
ただのオブジェクトに落としてから受け渡す。
