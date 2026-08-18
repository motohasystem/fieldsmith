# vck お試し手順書

全機能を一通り動かすための手順。所要 30〜45 分。

**副作用の小さい順に並べてある。** 第 1 部は接続も課金も無し、第 2 部から kintone にアプリが
作られ、第 4 部で Claude API に課金が発生する。途中でやめても構わない。

| 部 | 内容 | kintone | Claude API |
|---|---|---|---|
| [1](#第-1-部-接続なしで試す) | 書き方を知る・検証する | 触らない | 使わない |
| [2](#第-2-部-アプリを作る) | アプリを作る | **アプリが増える** | 使わない |
| [3](#第-3-部-既存アプリを更新する) | 取得・比較・更新 | **設定が変わる** | 使わない |
| [4](#第-4-部-文章から作る-課金あり) | 文章から生成 | アプリが増える | **課金あり** |
| [5](#第-5-部-後片付け) | 後片付け | — | — |

> **作ったアプリは自動では消せない。** kintone にアプリ削除の REST API は無いので、
> 最後に画面から手で削除する。検証用のドメインで試すことを勧める。

---

## 準備

### 必要なもの

- Node.js 20 以上
- kintone のアカウント（**アプリの作成権限**が要る）
- cybozu.com 共通管理の権限（OAuth クライアントを登録するため）
- 第 4 部だけ: Claude API のキー、または `ant auth login` 済みの環境

### インストール

```bash
git clone https://github.com/motohasystem/vibecraft-kintone.git
cd vibecraft-kintone
npm install
npm run build
```

以降 `vck` と書くところは `npm run vck --` に読み替える。

```bash
npm run vck -- schema      # = vck schema
```

### OAuth クライアントの登録

cybozu.com 共通管理 → 外部サービス連携 → **OAuth クライアント** で登録する。

| 項目 | 値 |
|---|---|
| クライアント名 | `vck` など |
| リダイレクトエンドポイント | 転送先の URL（実在しなくてよい。例: `https://example.com/callback`）|

登録すると **クライアント ID / シークレット / 認可エンドポイント / トークンエンドポイント**
が払い出される。`.env` に写す。

```bash
cp .env.example .env
```

```bash
KINTONE_BASE_URL=https://<サブドメイン>.cybozu.com
KINTONE_OAUTH_CLIENT_ID=...
KINTONE_OAUTH_CLIENT_SECRET=...
KINTONE_OAUTH_REDIRECT_URI=https://example.com/callback
KINTONE_OAUTH_AUTHORIZATION_ENDPOINT=...
KINTONE_OAUTH_TOKEN_ENDPOINT=...
```

---

## 第 1 部: 接続なしで試す

**kintone にも Claude にも接続しない。** `.env` すら要らない。

### 1-1. AppSpec の書き方を見る

```bash
vck schema
```

対応フィールド型、型ごとに指定できるキー、指定できない型が出る。
すべて実装の定義から導出しているので、実装とずれない。

```bash
vck schema --json      # 完全な JSON Schema
```

### 1-2. 実例を取り出す

```bash
vck schema --example > try.json
```

案件管理アプリの AppSpec が出る。アイコン、レイアウトの `group`、選択肢、
一覧の絞り込みまで一通り入っている。中を開いて眺めておく。

### 1-3. 検証する

```bash
vck deploy try.json --dry-run
```

kintone に送る内容がそのまま表示される。確認するところ:

- `アイコン: 💼 を 絵文字として描画 (10KB)` — 絵文字から画像を作っている
- `フォームの並び (最大 3 列 → N 行)` — `group` に沿って横に並ぶ予定が見える
- `properties` の中で、`options` が `{ ラベル: { label, index } }` に変換されている

### 1-4. わざと壊してみる

```bash
cat > bad.json <<'EOF'
{
  "name": "だめな例",
  "fields": [
    { "type": "STATUS", "label": "状態" }
  ]
}
EOF

vck deploy bad.json --dry-run
echo "終了コード: $?"
```

```
AppSpec の検証に失敗しました
  fields.0.type: STATUS: プロセス管理の設定で追加されるフィールドのため、フィールド追加 API では追加できません
終了コード: 2
```

指定できない型は、他の検証より先に打ち切って理由を返す。
書き方の誤りはまとめて返る。

```bash
echo '{"name":"だめな例2","fields":[{"type":"DROP_DOWN","label":"確度"},{"type":"SINGLE_LINE_TEXT"}]}' > bad2.json
vck deploy bad2.json --dry-run
```

```
AppSpec の検証に失敗しました
  fields.0.options: 選択肢を options に配列で指定してください (例: ["高", "中", "低"])
  fields.1.label: label (フィールド名) は必須です
```

**kintone に 1 リクエストも投げる前に**弾かれる。終了コードは種類ごとに分かれている
（2 = AppSpec を直す、3 = login し直す、4 = `.env` を直す）。

### 1-5. 機械可読な出力を見る

```bash
vck deploy bad.json --dry-run --json | head -20
```

`--json` を付けると **stdout は JSON だけ**になり、進捗や人間向けの表示は stderr に回る。
`error.hint` に次の一手が入る。AI エージェントから使うときはこの形になる。

---

## 第 2 部: アプリを作る

ここから kintone に接続する。**実行するとアプリが 1 つ増える。**

### 2-1. 認可する

```bash
vck login
```

表示された URL をブラウザで開いて許可し、**転送先のアドレスバーの URL をそのまま貼り付ける**。
（リダイレクト先のページが存在しなくても、URL さえ取れればよい）

要求されるスコープは 3 つ。

| スコープ | 用途 |
|---|---|
| `k:app_settings:write` | アプリ作成、フィールド追加、反映 |
| `k:app_settings:read` | 反映状況の確認 |
| `k:file:write` | アイコン画像のアップロード |

トークンは `~/.config/vck/tokens.json`（パーミッション 0600）に保存される。
アクセストークンは 1 時間で切れるが自動更新されるので、再ログインは基本不要。

### 2-2. デプロイする

```bash
vck deploy try.json
```

```
「案件管理」をデプロイします (フィールド 7 件)
  アプリ「案件管理」を動作テスト環境に作成します
  アプリ ID 123 を作成しました
  フィールドを 7 件追加します
  フォームの並びを整えています
  アイコンを生成しています (💼)
  アイコンをアップロードしました (絵文字)
  一般設定を適用します
  一覧を設定します
  運用環境へ反映します
  反映の完了を待っています
  反映状況: SUCCESS

✓ デプロイが完了しました。
  アプリ ID: 123
  URL: https://<サブドメイン>.cybozu.com/k/123/
```

**表示されたアプリ ID を控えておく。** 以降 `<APP_ID>` と書く。

### 2-3. kintone の画面で確認する

URL を開いて、次を見る。

- **アプリアイコン**が 💼 の画像になっている（紫の角丸背景）
- **フォーム**で「案件名 / 顧客名」が横に並び、「受注確度 / 受注予定日」が別の行になっている
  （`group` に沿った配置）
- **備考**（複数行テキスト）は単独行
- **一覧**が「全件」と「確度の高い案件」の 2 つある
- 「確度の高い案件」を開くと、受注確度が「高」のものだけに絞られている

### 2-4. 反映状況を確認する

```bash
vck status <APP_ID>
```

```
アプリ 123: SUCCESS
```

### 2-5. 同じ spec からもう 1 つ作る（任意）

```bash
vck deploy try.json
```

**まったく同じアプリがもう 1 つできる。** これが vck の中心にある性質で、
検証環境と本番に同じものを作ったり、テンプレートから量産したりできる。

> 増やした分だけ後で消す手間が増えるので、1 つで十分なら飛ばしてよい。

---

## 第 3 部: 既存アプリを更新する

`<APP_ID>` は第 2 部で作ったアプリ。

### 3-1. 現状を取り出す

```bash
vck pull <APP_ID> -o current.json
```

**読み取りしかしない。** いつ実行しても安全。

```
  アプリ 123 の設定を取得しています
  「案件管理」を AppSpec にしました
✓ current.json に保存しました。

次の設定は AppSpec で表現できないため含まれていません:
  - アプリアイコンに画像が設定されていますが、AppSpec には含められません。
```

`try.json` と `current.json` を見比べる。

- フィールドに `code` が明示されている（`pull` は同一性の鍵を必ず書く）
- `"layout": "stacked"` が付いている（AppSpec は任意のレイアウトを表現できないので、
  「既存の並びに手を触れない」指定になる）
- `icon` が無い（画像から絵文字には戻せない。だから警告が出る）

### 3-2. 編集する

`current.json` を開いて、次の 3 つを変える。

1. `description` を書き換える
2. 「受注確度」の `options` を `["S", "A", "B", "C"]` にし、`defaultValue` を `"B"` にする
3. 「顧客名」のフィールドをまるごと**削除する**

3 をやると一覧が「顧客名」を参照したままになるので、`views` の `fields` からも外す。
（外し忘れると次で弾かれる。それも確かめる価値がある）

### 3-3. 差分を見る

```bash
vck diff <APP_ID> current.json
```

```
  ~ description: … → …
  ~ 受注確度: options: ["高","中","低"] → ["S","A","B","C"], defaultValue: 中 → B
  - 顧客名 (SINGLE_LINE_TEXT) を削除候補へ
  ~ 一覧「全件」: fields

- 削除候補のフィールドは削除されず、畳んだグループに移されます (データは残ります)。
```

| 記号 | 意味 |
|---|---|
| `+` | 追加する |
| `~` | 設定を変更する |
| `!` | **kintone では実行できない**（型変更）|
| `-` | 削除候補にする（**削除しない**）|

これも読み取りだけ。

### 3-4. 適用する（運用環境にはまだ出さない）

```bash
vck update <APP_ID> current.json
```

```
動作テスト環境まで反映しました。運用環境にはまだ反映していません。
  https://<サブドメイン>.cybozu.com/k/<APP_ID>/ で「変更を確認」してください。
  問題なければ --deploy を付けて再実行します。
```

**既定では運用環境に出ない。** 更新は壊しうるので、人が画面で確認してから決められる。

### 3-5. kintone の画面で確認する

アプリを開くと上部に「**変更を確認**」というボタンが出ている。押すと、
動作テスト環境の状態がプレビューできる。ここで見るところ:

- フォームの下のほうに「**削除候補**」という**畳まれたグループ**がある
- 開くと「顧客名」が入っている。**削除されていない**ので、データも残っている

### 3-6. もう一度流してみる（冪等性）

```bash
vck update <APP_ID> current.json
```

```
アプリ 123「案件管理」に適用する変更はありません。
  1 件のフィールドは、すでに削除候補グループに入っています。
```

**何も起きない。** `update` は運用環境ではなく動作テスト環境を読んで差分を取るので、
反映前に何度流しても同じ結果になる。

### 3-7. 運用環境へ反映する

```bash
vck update <APP_ID> current.json --deploy
```

反映されない場合は、3-4 の段階で kintone の画面から「変更を中止」してしまっていないか確認する。

### 3-8. 型を変えようとしてみる（任意）

`current.json` で「備考」の `type` を `SINGLE_LINE_TEXT` に変えて実行する。

```bash
vck update <APP_ID> current.json
```

```
kintone は作成後のフィールド型を変更できないため、この AppSpec は適用できません。
    備考: MULTI_LINE_TEXT → SINGLE_LINE_TEXT
  別のフィールドコードで新しいフィールドを作り、古い方は AppSpec から外してください
  (外したフィールドは削除候補に移ります。データは残ります)。
```

**何も送らずに止まる。** 一部だけ適用して spec と実物がずれるより安全という判断。
確認したら `type` を戻しておく。

---

## 第 4 部: 文章から作る（課金あり）

ここから **Claude API に課金が発生する。** 1 回あたり数円程度だが、承知のうえで進める。

### 4-1. 認証情報を用意する

`.env` に足すか、環境変数で渡す。

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

`ant auth login` 済みなら未設定でも動く。

### 4-2. 要件を書く

```bash
cat > requirements.md <<'EOF'
# 問い合わせ管理アプリ

顧客からの問い合わせを記録して、対応状況を追跡したい。

## 記録したいこと
- 件名（必須）
- 問い合わせ内容
- 顧客名、連絡先メールアドレス
- 対応状況（未対応 / 対応中 / 完了）
- 担当者
- 受付日、完了日
- 対応メモ

## 見たい一覧
- 未対応と対応中だけを、受付日の古い順で
EOF
```

### 4-3. AppSpec を作る

```bash
vck plan -f requirements.md -o inquiry.json
```

生成中は経過が動く。`--verbose` を付けると思考の要約も流れる。

```
⠹ 設計を書き出しています (612 文字) (14秒)
✓ 設計を生成しました (23 秒, 入力 1243 / 出力 892 トークン)

アプリ名: 問い合わせ管理
アイコン: 📮 (背景 #0891b2)
フィールド (9 件):
  - 件名 [SINGLE_LINE_TEXT, 必須]
  - 対応状況 [DROP_DOWN, 未対応 / 対応中 / 完了]
  ...
フォームの並び (最大 3 列 → 6 行):
  件名
  顧客名 | メールアドレス
  ...
```

`plan` は **kintone に接続しない。** 生成された JSON を開いて確かめる。
気に入らなければ手で直せばよい。

### 4-4. デプロイする

```bash
vck deploy inquiry.json --dry-run   # まず確認
vck deploy inquiry.json
```

### 4-5. 指示だけで更新案を作る

第 4-4 で作ったアプリの ID を使う。

```bash
vck revise <APP_ID> "対応状況に「保留」を足して、優先度（高/中/低）のフィールドを追加して" -o revised.json
```

```
この AppSpec を適用すると、こうなります:

  + 優先度 (DROP_DOWN) を追加
  ~ 対応状況: options: ["未対応","対応中","完了"] → ["未対応","対応中","保留","完了"]

確認したら: vck update <APP_ID> revised.json
```

**何が起きるかは、モデルの自己申告ではなく決定的な差分で示される。**
`revise` も kintone は読むだけで、適用はしない。

```bash
vck update <APP_ID> revised.json
vck update <APP_ID> revised.json --deploy
```

### 4-6. 一気にやる（任意）

```bash
vck create -f requirements.md
```

生成 → 内容を表示 → **確認を求める** → デプロイ、まで一度に進む。
`-y` を付けると確認を飛ばす（AI エージェントから呼ぶときはこちら）。

---

## 第 5 部: 後片付け

### 作ったアプリを消す

**kintone にアプリ削除の REST API は無い。** 画面から手で削除する。

1. アプリを開く
2. 右上の歯車 → アプリの設定
3. 「設定」タブ → **このアプリを削除**

第 2 部と第 4 部で作ったすべてのアプリについて行う。

### トークンを破棄する（任意）

```bash
vck logout
```

`~/.config/vck/tokens.json` から該当ドメインの分が消える。

### 作業ファイル

`try.json` `bad.json` `bad2.json` `current.json` `revised.json` `inquiry.json` `requirements.md`
は消してよい。

---

## AI エージェントから使う

エージェントの仕事は AppSpec を書くことで、デプロイはシェルコマンド 1 つ。

```bash
vck schema > reference.md               # 1. 書き方を読ませる
# 2. エージェントが spec.json を書く
vck deploy spec.json --dry-run --json   # 3. 検証（認証不要）。exit 2 なら issues を読んで直す
vck deploy spec.json --json             # 4. デプロイ
```

`--json` を付けると stdout は JSON だけになる。失敗も同じ形で返り、`error.hint` に
次の一手が入る。`login` だけは人間が一度やる必要があるが、それ以外は非対話で動く。

---

## つまずきやすいところ

| 症状 | 原因と対処 |
|---|---|
| `Claude API の認証情報が見つかりません` | 第 4 部だけで必要。`ANTHROPIC_API_KEY` か `ant auth login`。kintone の `vck login` とは別物 |
| `保存済みの認証情報にスコープ … が含まれていません` | 古いトークン。`vck login` をやり直す |
| `403 CB_OA01` | OAuth のスコープ不足。`vck login` をやり直す |
| `アプリの作成に失敗しました` | 実行ユーザーに「アプリの作成」権限が無い |
| `サーバーの応答を待っています` のまま進まない | Claude API への接続待ち。180 秒で打ち切る。プロキシ配下なら要設定 |
| 並べ替えたのに `diff` が反応しない | `layout` が `stacked` だと並びに手を触れない。`"layout": "grouped"` にする |
| `update` しても何も変わらない | `--deploy` を付けていない（既定では動作テスト環境で止まる） |
