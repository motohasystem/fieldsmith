---
name: kintone-appspec
description: kintone アプリの設計図である AppSpec（JSON）を書き、fieldsmith（旧 vck / vibecraft-kintone）で検証してから作成・更新する。新規作成（`deploy`）と、既存アプリの更新（`pull` → 編集 → `diff` → `update`）の両方を扱う。ユーザーが「kintone アプリを作って」「◯◯管理のアプリが欲しい」「AppSpec を書いて/直して」「既存アプリに項目を足して」「このアプリの設定を取り出して」「spec と実物の差分を見て」「同じアプリを別のスペースにもう1つ」などと言ったら使う。新規作成のスペース ID とスレッド ID は必須で、分からなければユーザーに聞いてから進める。デプロイ・更新は必ずユーザーの明示的な確認を得てから実行する。Use when creating, authoring, validating, diffing, updating, or deploying a kintone app spec with the fieldsmith CLI.
---

# AppSpec で kintone アプリを作る・直す

CLI の名前は **`fieldsmith`**（npm 公開済み）。以前の `vck` / `vibecraft-kintone` は同じものの旧名なので、古い名前が出てきたら読み替える。

経路は 2 つ。**どちらなのかを最初に確定させる。**

| | 新規作成 | 既存アプリの更新 |
|---|---|---|
| 流れ | 要件 → AppSpec → `--dry-run` → 確認 → `deploy` | `pull` → 編集 → `diff` → 確認 → `update` → `--deploy` |
| アプリ ID | 実行後に採番される | **最初に必要**（無ければ聞く） |
| 配置先 | `space` / `thread` が**必須** | 既存アプリのまま（動かせない） |

「アプリを作って」と言われても、**似たアプリが既にあるなら更新のほうが正しい**ことがある。既存アプリの話が出たらアプリ ID を聞く。

## 押さえておく性質

- **`deploy` は LLM を呼ばない。** 同じ AppSpec からは常に同じアプリができる。設計の判断は AppSpec を書く時点で終わっている
- **`deploy` は毎回「新しいアプリ」を作る。既存アプリは変わらない。** 既存を変えるのは `update`
- **`--dry-run` は kintone にも Claude API にも接続しない。** 認証すら要らないので、通るまで何度でも回す
- **`update` は既定で運用環境に反映しない**（動作テスト環境で止まる）。反映は `--deploy` を付けた再実行
- **フィールドは消えない。** AppSpec から外したフィールドは `_削除候補` グループへ移るだけ。データは残る
- **フィールドの型は作成後に変えられない。** `update` は何も送らずに止まる
- **AppSpec に書かれていない項目は現状維持。** 値を変えたいときは明示的に書く

## 呼び方

このスキルの `scripts/fieldsmith.sh` を使う。**インストール不要**（`npx -y fieldsmith` に落ちる）で、cwd を変えないので spec は相対パスで渡してよい。

```bash
F="bash <skill_dir>/scripts/fieldsmith.sh"
$F schema
```

ラッパーがやるのは 2 つだけ。

1. **本体を見つける** — PATH の `fieldsmith` → `npx -y fieldsmith`
2. **`.env` を見つける** — fieldsmith 本体は **cwd の `.env` しか読まない**。エージェントの cwd が kintone の設定を置いた場所とは限らないので、ラッパーが探して環境変数に入れる。探す順は `FIELDSMITH_ENV` → cwd から上へ辿って最初の `.env`（`$HOME` まで）→ `~/.config/fieldsmith/.env`

| 環境変数 | 使うとき |
|---|---|
| `FIELDSMITH_ENV=/path/to/.env` | `.env` の場所を明示する（自動探索で見つからないとき） |
| `FIELDSMITH_DIR=/path/to/repo` | fieldsmith 本体を開発中で、ソースを直接動かしたいとき |
| `FIELDSMITH_USE_NPX=1` | PATH に古い `fieldsmith` があり、npm 公開版を使わせたいとき |

- OAuth のトークンは `~/.config/fieldsmith/tokens.json`（`FIELDSMITH_CONFIG_DIR` で変更可）にあり、cwd に依存しない。cwd で変わるのは `.env` だけ
- ユーザーが自分で叩くコマンドを案内するときは、ラッパーではなく素の `fieldsmith ...`（未インストールなら `npx -y fieldsmith ...`）で書く
- 権限の確認が煩わしいと言われたら [skills/README.md の Permissions](https://github.com/motohasystem/fieldsmith/blob/main/skills/README.md#permissions) を案内する。**パターンは実際に打たれるコマンド文字列（`bash .../fieldsmith.sh ...`）に合わせる必要がある**

| コマンド | kintone | Claude | 備考 |
|---|---|---|---|
| `schema` / `schema --json` / `schema --example` | 触らない | 呼ばない | 書き方・完全な JSON Schema・実例 |
| `deploy <spec> --dry-run` | **触らない** | 呼ばない | 認証不要。検証ループはここで回す |
| `deploy <spec>` | **作る** | 呼ばない | 毎回新しいアプリ |
| `pull <appId> -o <spec>` | 読むだけ | 呼ばない | いつ実行しても安全 |
| `diff <appId> <spec>` | 読むだけ | 呼ばない | 何が起きるかを決定的に出す |
| `update <appId> <spec>` | **書く**（動作テスト環境） | 呼ばない | 運用環境には出ない |
| `update <appId> <spec> --deploy` | **書く**（運用環境まで） | 呼ばない | 人の確認後に |
| `revise <appId> [指示] -o <spec>` | 読むだけ | **呼ぶ** | 原則使わない（下記） |
| `status <appId>` | 読むだけ | 呼ばない | 反映状況 |
| `login` / `logout` | — | — | OAuth のときだけ。**対話。人に頼む** |

`--json` を付けると **stdout は JSON だけ**になり、進捗は stderr に回る。失敗も同じ形で返り、`error.kind` / `exitCode` / `hint` / `issues` が入るので、機械的に処理したいときはこちら。

## リポジトリにある読み物

[motohasystem/fieldsmith](https://github.com/motohasystem/fieldsmith) には、そのまま使える材料がある。手元にクローンがあればそれを読み、無ければ下のリンクを開く。

| どこ | 何 |
|---|---|
| [`examples/*.json`](https://github.com/motohasystem/fieldsmith/tree/main/examples) | すぐ deploy できる AppSpec の実例 5 本（案件管理 6 / 書籍管理 10 / 本棚 8 / 蔵書管理 18 / 蔵書 18 フィールド）。**書き方に迷ったら `schema` と併せて読む** |
| `examples/requirements-*.md` | `plan` に渡す要件文の例 |
| [`docs/setup-password.md`](https://github.com/motohasystem/fieldsmith/blob/main/docs/setup-password.md) | パスワード認証のセットアップ手順 |
| [`docs/setup-oauth.md`](https://github.com/motohasystem/fieldsmith/blob/main/docs/setup-oauth.md) | OAuth のセットアップ手順 |
| [`docs/walkthrough.md`](https://github.com/motohasystem/fieldsmith/blob/main/docs/walkthrough.md) | 全機能を一通り試す手順書 |
| [`docs/claude-code.md`](https://github.com/motohasystem/fieldsmith/blob/main/docs/claude-code.md) | Claude Code から使うときの考え方（このスキルの背景） |

**`examples/` の spec は環境非依存**（`space` を持たない）。ここから複製して使うときは、**必ず `space` / `thread` を足す**か `--space` / `--thread` で渡す。逆に、環境固有の値が入った spec を `examples/` に置かない。

## 認証

kintone 側は**パスワード認証か OAuth のどちらか**（`.env`）。パスワード認証なら `fieldsmith login` は要らない。OAuth のときだけ一度ブラウザでの認可が要る。

セットアップ手順は本体のドキュメントにある。**自分で手順を再発明せず、これを案内する。**

- パスワード認証: [docs/setup-password.md](https://github.com/motohasystem/fieldsmith/blob/main/docs/setup-password.md)
- OAuth: [docs/setup-oauth.md](https://github.com/motohasystem/fieldsmith/blob/main/docs/setup-oauth.md)

- 終了コード **3**（`auth`）→ OAuth の認可が切れている。`login` は対話なので**ユーザーに依頼する**
- 終了コード **4**（`config`）→ `.env` が見つからないか埋まっていない。**まず `.env` の場所を疑う**（本体は cwd の `.env` しか読まない）。ラッパー経由なら `FIELDSMITH_ENV` で明示できる。ファイル自体が無いなら上のセットアップ手順を案内する
- いま何で繋いでいるかは `--verbose` で分かる

`--dry-run` と `schema` は認証不要。**認証が要るのは kintone に触る操作だけ。**

## A. 新規アプリを作る

### 1. 要件と配置先を掴む

- 1 レコード = 何か（1 冊の本 / 1 件の案件 / 1 回の問い合わせ）
- **必ず埋まる項目**はどれか（= `required`）
- 一覧で**上から順に見たい切り口**があるか（= `views` の `filterCond` / `sort`）
- **どのスペースのどのスレッドに作るか**（= `space` / `thread`。必須。次節）

曖昧でも聞きすぎない。**叩き台を 1 つ出して直すほうが速い**（`space` / `thread` を除く）。

### 2. 配置先（space / thread）— 必須

**スペース ID とスレッド ID が確定するまで deploy しない。** 会話に出ていなければ聞く。推測で埋めたり、省略して進めたりしない（スペース外に出たアプリは後から移せず、作り直しになる）。

聞き方はこれが速い（ID を 2 つ聞くより間違いが少ない）:

> 作成先のスペースを kintone で開いて、アドレスバーの URL をそのまま貼ってください。

```
https://<sub>.cybozu.com/k/#/space/12/thread/34
                                       ↑        ↑
                                    space=12  thread=34
```

- スペースのトップ（`/k/#/space/12`）だけを貼られたら、**スレッドを開いた状態の URL** を貰い直す
- ゲストスペース（`/k/guest/7/#/space/...`）なら `guestSpaceId` も要る
- 過去の spec の値を候補に出してよいが、**採用の確認は取る**

確定したら AppSpec 本体に書く（spec だけ見れば配置先が分かる状態にする）。同じ spec を別スペースに複製するときだけ CLI の `--space` / `--thread` で上書きする（CLI が優先）。

### 3. 書き方を確認する（毎回やる）

```bash
$F schema            # 簡潔な一覧
$F schema --example  # そのまま deploy できる実例
```

**フィールド型やキー名を記憶で書かない。** この出力は Zod の定義から自動生成されているので実装とズレない。規模の近い `examples/*.json` があればそれも読む。

### 4. AppSpec を書く

- 保存先は**ユーザーの作業ディレクトリ**に `<名前>.json`。ファイル名は日本語でよい（`examples/` の慣習に合わせる）
- 要件メモを残すなら同じ場所に `<名前>.md`
- **`space` / `thread` の入った実運用の spec を fieldsmith リポジトリの `examples/` に置かない**（あそこは環境非依存のサンプル置き場）

設計の指針は下の「設計の指針」節。

### 5. 検証する（通るまで回す）

```bash
$F deploy 案件管理.json --dry-run
```

終了コード **2** なら AppSpec が不正。エラーを読んで直し、また回す。通ると「kintone に送る内容」が出るので、**フィールドの並びと一覧の中身をここで自分で確認する**。

> **注意: `--dry-run` の出力は `space` / `thread` を表示しない。** 検証を通っても「スペースに属さないアプリになる」ことは警告されない。配置先は **spec ファイルの `space` / `thread` 行を自分で読んで確認する**。

### 6. 見せて、確認を取ってから deploy する

deploy は取り消せない（不要なアプリが kintone に残る）。

- 要約を見せる。**スペース ID とスレッド ID を必ず含める**（アプリ名 / フィールド数 / 一覧 / space=◯ thread=◯）
- **明示的な「デプロイして」を得てから実行する**
- 成功したらアプリ ID と URL を伝える

## B. 既存アプリを更新する

```bash
F="bash <skill_dir>/scripts/fieldsmith.sh"
$F pull 761 -o 案件管理-761.json        # 1. 現状を AppSpec として取り出す（読み取りのみ）
                                        # 2. ファイルを編集する
$F diff 761 案件管理-761.json           # 3. 何が起きるかを確かめる（読み取りのみ）
$F update 761 案件管理-761.json         # 4. 動作テスト環境まで適用する
$F update 761 案件管理-761.json --deploy   # 5. 確認が取れたら運用環境へ反映する
```

### pull の警告を握りつぶさない

AppSpec は kintone の設定を全部は表現できない。`pull` は落としたものを警告として必ず出す（`--json` なら `warnings`）。**この内容は要約せず、そのままユーザーに伝える。**

現状で落ちるもの: テーブル・ルックアップ・関連レコード一覧などの未対応フィールド型、カスタマイズ一覧、アプリアイコンの画像、細かなレイアウト。

`pull` が返す `layout` は 2 通り。グループフィールドがあれば `"sections"`（`group` に所属も復元される）、無ければ `"stacked"`（＝既存の並びに触らない）。

**どちらも書き換えない。** 並びを変えたいと頼まれた時だけ `"grouped"` にする。書き換えると差分に「フォームの並びを組み直す」が出る。

### 編集するときの鉄則

- **既存フィールドの `code` は絶対に変えない。** 同一性はコードで決まる。変えると「別フィールドの追加 + 元は削除候補」になり、**データは新しいフィールドに入らない**。ラベルだけ変えるときも `code` は据え置く
- **既存フィールドの `type` は変えない。** kintone では不可能。`update` は何も送らずに止まる
- 新しいフィールドだけ `code` を空にする（`label` から導出される）
- 頼まれていないフィールド・一覧は、`pull` した内容のまま書き写す
- 変えたい設定は**明示的に書く**（書かれていない項目は現状維持）

### diff の読み方

| 記号 | 意味 |
|---|---|
| `+` | 追加する |
| `~` | 設定を変更する |
| `!` | **kintone では実行できない**（型変更）。止まるので直す |
| `-` | 削除候補にする（**削除しない**。`_削除候補` グループへ移るだけでデータは残る）|

`!` が出たら、実現するには「別の `code` で新しいフィールドを作り、古い方を AppSpec から外す」しかない。**データは移らない**ことを必ず伝えてから決めてもらう。

`-`（削除候補）が出たら、**それが意図した削除かを確認する**。`pull` した内容を写し損ねただけ、ということが起きやすい。

### 確認と反映

- `update` の前に `diff` の出力を見せて、確認を取る
- `update`（`--deploy` なし）は動作テスト環境まで。ユーザーに kintone の画面で「変更を確認」してもらう
- **`--deploy` は別途、明示的な OK を得てから。** 運用環境が変わる操作
- `update` は冪等（動作テスト環境を読んで差分を取るので、2 回流しても二重に追加されない）

## revise は原則使わない

`revise` は指示から更新後の AppSpec を LLM に書かせるコマンド。**このスキルでは使わない** — `pull` した spec を私が直接編集して `diff` を取れば同じことができ、Claude API の課金が二重にならず、会話の文脈も渡せる。ユーザーが明示的に「revise で」と言った場合だけ使う。

同じ理由で `plan` / `create` も使わない。

## 設計の指針

### フィールド型の選び方

- 短いテキスト（名称・件名・コード）→ `SINGLE_LINE_TEXT`
- 長文（備考・内容）→ `MULTI_LINE_TEXT`
- 金額・数量 → `NUMBER`。金額なら `digit: true` と `unit: "円"`, `unitPosition: "AFTER"`
- 選択肢 2〜4 個で必ず 1 つ選ぶ → `RADIO_BUTTON`、5 個以上または省略可 → `DROP_DOWN`
- 複数選べる → `CHECK_BOX`（少ない）/ `MULTI_SELECT`（多い）
- 日付 → `DATE`、日時 → `DATETIME`、時刻 → `TIME`
- 社内の人（担当者・承認者）→ `USER_SELECT`
- URL / メール / 電話 → `LINK`（`protocol` を `WEB` / `MAIL` / `CALL`）
- 他フィールドからの計算 → `CALC`。`expression` は**フィールドコード**で書く（例 `"単価 * 数量"`）

ラベルは**業務で使われている日本語のまま**にする。英語に訳さない。要件に無い項目を推測で大量に足さない（ステータス的な区分・担当者・日付は、業務上明らかに要るなら補ってよい）。

### `group`（意味のまとまり）

`group` は「意味のまとまりの名前」。`layout` の指定で扱いが変わる。

| `layout` | `group` の効き方 |
|---|---|
| `"grouped"`（既定） | 横に並べる単位。kintone には送られない |
| `"sections"` | **kintone のグループフィールド**になる。名前がそのまま表示される |
| `"stacked"` | 何も起きない |

- **意味のまとまり**で付ける。型ではなく業務上の役割で（書誌情報 / 貸出 / 分類 / 所在）
- **同じ `group` のフィールドは必ず続けて並べる。** 離れていると検証で弾かれる
- 1 group は 2〜3 個が目安（既定の `maxPerRow` は 3）
- 横に並べたくないなら `"layout": "stacked"`

`sections` を使うのは、**ユーザーがフォーム上のまとまりを明示的に求めたとき**（「項目をグループでまとめて」「セクションに分けて」など）。既定は `grouped` のままでよい。`sections` では `group` の名前がフィールドコードになるので、フィールドコードと重ならない名前にする。

`MULTI_LINE_TEXT` `RICH_TEXT` `FILE` は幅・高さを取るので常に単独行になる。

### 一覧（views）

- 表形式 `LIST` が基本。`CALENDAR` は `date` が必須
- 少なくとも 1 つは**全件が見える**一覧を入れる
- `fields` に書けるのは自分で定義したフィールドコードと、組み込みの `レコード番号` `作成者` `作成日時` `更新者` `更新日時` だけ

### icon / settings

- `icon` に絵文字 1 文字（書籍管理なら 📚、案件管理なら 💼）。**肌色や ZWJ の複雑な絵文字は避ける**。頭文字（「蔵書」など 1〜3 文字）も使える
- `settings.titleFieldCode` に、その 1 件を識別できるフィールド（案件名・氏名）を指定する

## よくある検証エラーと直し方

| エラー | 直し方 |
|---|---|
| `STATUS` / `ASSIGNEE` / `CATEGORY`: プロセス管理の設定で追加される… | フィールド追加 API では作れない。`DROP_DOWN` か `RADIO_BUTTON` で代用 |
| `LOOKUP` / `SUBTABLE` / `REFERENCE_TABLE` / `GROUP`: v1 では未対応 | 別のフィールドで表現し直す。「今は作れないので手で足す必要がある」と伝える |
| `RECORD_NUMBER` / `CREATOR` / `CREATED_TIME` …: 自動生成される | `fields` から消す。`views.fields` には書ける |
| `defaultValue "中" が options に含まれていません` | `options` に足すか `defaultValue` を直す。`RADIO_BUTTON`/`DROP_DOWN` は文字列、`CHECK_BOX`/`MULTI_SELECT` は配列 |
| `group "◯◯" のフィールドが離れて書かれています` | 同じ group を連続させる。並べ替えたくないなら片方の group 名を変える |
| `フィールドコード "◯◯" は fields に存在しません` | `views.fields` / `settings.titleFieldCode` の綴りを直す。`code` 省略時は `label` から導出される点に注意 |
| `フィールドコードの先頭に数字は使用できません` / 使用できない文字 | `code` を明示する。`( ) / \ - = + * < > % 空白` などは使えない。日本語は使える |
| `kintone は作成後のフィールド型を変更できないため…`（update） | 別の `code` で新フィールドを作り、古い方を AppSpec から外す。**データは移らない**と伝えて確認を取る |

選択肢は必ず `"options": ["高", "中", "低"]` の**文字列の配列**。索引付きオブジェクトへの変換は fieldsmith がやる。

### `--dry-run` を通り抜けて deploy 中に落ちるもの

`views` の `filterCond` は **kintone のクエリとして実行されるまで検証されない**。fieldsmith の検証はフィールドコードの存在までしか見ないので、演算子の誤りは `deploy` の終盤（「一覧を設定します」）で `[GAIA_IQ03]` として出る。

| やりがち | 何が起きる | 正しく書くと |
|---|---|---|
| `audio_key is not empty` | 文字列系フィールドに `is not` は使えない | `audio_key != ""` |
| `title is empty` | 同上 | `title = ""` |

`is` / `is not` が使えるのは `USER_SELECT` などの一部の型だけ。**文字列・数値は `=` / `!=` / `like` / `in` で書く。**

一覧の設定はデプロイの最後に走るので、ここで落ちるとアプリだけが動作テスト環境に残る。`--revert-on-failure` を付けておくと破棄まで自動でやる。

## 終了コードと、次の一手

| コード | `kind` | 次にやること |
|---|---|---|
| 0 | — | 成功 |
| 1 | `unknown` | 想定外。メッセージを確認する |
| 2 | `validation` | AppSpec を直して再実行（エージェントが自分で回す） |
| 3 | `auth` | OAuth の認可が要る。**対話なのでユーザーに依頼する** |
| 4 | `config` | `.env`（認証情報）を見直す。`docs/setup-*.md` を案内する |
| 5 | `kintone` | 権限（アプリの作成権限）を確認するか、時間をおいて再試行 |
| 6 | `generation` | （`plan` / `revise` のみ）要件の書き方を変えて再実行 |
| 7 | `input` | ファイルパスやオプションを見直す |

## 失敗したとき

`deploy` は「動作テスト環境に作る → フィールド追加 → レイアウト → アイコン → 設定 → 一覧 → 運用環境へ反映」の順に進む。**途中で失敗すると、アプリは動作テスト環境にだけ存在して運用環境には出ていない**状態で残る（調査できるようにわざと残す）。エラーに含まれるアプリ ID をユーザーに伝える。

- 残骸を残したくない実行なら `--revert-on-failure`
- 反映が終わっているか怪しいときは `status <appId>`
- `update` が途中で落ちた場合も運用環境は無傷（`--deploy` を付けていない限り）。`diff` を取り直せば残りが分かる

## やらないこと

- **確認なしで `deploy` / `update --deploy` しない。** 前者は取り消せず、後者は運用環境が変わる
- **`space` / `thread` 未確定のまま `deploy` しない**（新規作成時）
- **既存フィールドの `code` と `type` を変えない。** データが失われる
- **`pull` の警告を要約・省略しない。** 落ちた設定は必ずそのまま伝える
- **環境固有の値が入った spec を `examples/` に置かない**
- **`login` を勝手に実行しない。** 対話操作なので必要になったら依頼する
- **`plan` / `create` / `revise` を勝手に使わない。** AppSpec はこのスキルで直接書く。ユーザーが明示したときだけ
