# Claude Code から使う

Claude Code に kintone アプリを作らせるときの設定と使い方。

このページの `CLAUDE.md` と `.claude/settings.json` は、**fieldsmith を使う側のプロジェクト**に
置くもの（fieldsmith 自体のリポジトリではない）。

---

## いちばん大事なこと: `plan` / `revise` は使わない

fieldsmith には要件の文章から AppSpec を作る `plan` / `revise` / `create` がある。
これらは内部で Claude API を叩く。**Claude Code から呼ぶと LLM が LLM を呼ぶことになる。**

- トークンを二重に払う
- 会話の文脈（どんな業務か、何を作りたいか）が内側の LLM に伝わらない
- 生成結果を Claude Code が直接見て直せない

**Claude Code は自分で AppSpec を書いたほうが速くて正確。** 文脈を全部持っているので。

| | Claude Code から |
|---|---|
| `schema` `deploy` `pull` `diff` `update` `status` | **使う** |
| `plan` `create` `revise` | 使わない（CLI 単体で完結させるためのもの）|

## 手順

```bash
fieldsmith schema                              # 1. 書き方を読む（4,600 文字）
                                               # 2. Claude Code が spec.json を書く
fieldsmith deploy spec.json --dry-run --json   # 3. 検証（資格情報なしで通る）
fieldsmith deploy spec.json --json             # 4. デプロイ
                                               # 5. 返ってきたアプリ ID を控える
```

**1 を飛ばさせないこと。** フィールド型ごとに指定できるキーが違い、指定できない型もある。
記憶で書き始めると、`--dry-run` で弾かれて往復が増える。

**5 も忘れやすい。** `deploy` の応答に `app.id` が入っている。控えておかないと、
あとで直したくなったときに対象のアプリが分からなくなる。

**3 が肝。** kintone にも Claude にも接続しないので、無料・高速・副作用ゼロで
「書く → 検証 → 直す」を何度でも回せる。失敗すると終了コード 2 と `issues` が返る。

```json
{
  "ok": false,
  "error": {
    "kind": "validation",
    "exitCode": 2,
    "hint": "AppSpec を直して再実行する",
    "issues": [
      { "path": "fields.1.options", "message": "選択肢を options に配列で指定してください (例: [\"高\", \"中\", \"低\"])" }
    ]
  }
}
```

`schema --json`（完全な JSON Schema、36,000 文字）は**読ませない**。
既定の一覧（4,600 文字）で足りる。

## 認証はパスワード認証に

OAuth だと `fieldsmith login` でブラウザ認可が要り、そこでエージェントが止まる。
パスワード認証なら最初から最後まで非対話で動く。

```bash
# 使う側のプロジェクトの .env
KINTONE_BASE_URL=https://<サブドメイン>.cybozu.com
KINTONE_USERNAME=<ログイン名>
KINTONE_PASSWORD=<パスワード>
```

## 注意: `deploy` は毎回新しいアプリを作る

更新ではない。**エージェントがループで叩くと、同じアプリが大量にできる。**
しかも kintone にアプリ削除の REST API は無いので、消すのは全部手作業になる。

既存アプリを直すときは `update` を使う。こちらは既定で動作テスト環境に留まり、
`--deploy` を付けるまで運用環境に出ない。人が kintone の画面で確認する関門が残る。

```bash
fieldsmith pull 123 -o current.json     # 現状を取り出す（読み取りのみ）
                                        # Claude Code が current.json を編集する
fieldsmith diff 123 current.json        # 何が起きるか確かめる（読み取りのみ）
fieldsmith update 123 current.json      # 動作テスト環境まで
                                        # 人が kintone の画面で「変更を確認」
fieldsmith update 123 current.json --deploy
```

編集するとき Claude Code に守らせること:

- **既存フィールドの `code` を変えない。** 変えると別フィールド扱いになり、
  追加 + 元は削除候補になって**データが引き継がれない**
- **既存フィールドの `type` を変えない。** kintone は作成後の型を変更できないので、
  `update` が何も送らずに失敗する
- フィールドを外したら、一覧（`views`）の `fields` からも外す

## AppSpec を書くときの勘所

`fieldsmith schema` に全部書いてあるが、間違えやすいところ:

- 選択肢は `"options": ["高", "中", "低"]` と**文字列の配列**で書く。索引付きのオブジェクトにしない
- `code` は省略してよい。`label` から導出される
- `STATUS` `ASSIGNEE` `CATEGORY` は指定できない。レコード番号・作成者・作成日時などは
  自動で用意されるので `fields` に書かない
- `group` は「意味のまとまり」の名前。同じ `group` のフィールドが横に並ぶので、
  **続けて書く**（離れていると検証で弾かれる）
- 書かれていない項目は「現状維持」。値を変えたいときは明示的に書く（`"required": false` など）

---

## 置くファイル

### `CLAUDE.md`

使う側のプロジェクトの直下に置く。そのままコピーしてよい。

````markdown
## kintone アプリの作成・更新

kintone アプリは [fieldsmith](https://github.com/motohasystem/fieldsmith) で扱う。
AppSpec（JSON）を書いて `fieldsmith` に渡す。

### 手順

1. **`npx fieldsmith schema` を実行して書き方を読む。**
   記憶で書き始めない。フィールド型ごとに指定できるキーが違い、
   指定できない型もあるので、毎回読んでから書く
2. `kintone/<アプリ名>.json` に AppSpec を書く
3. `npx fieldsmith deploy kintone/<アプリ名>.json --dry-run --json` で検証する
4. 通ったら `--dry-run` を外してデプロイする
5. **返ってきたアプリ ID を `kintone/apps.md` に記録する**

### ファイルの置き場所

```
kintone/
  <アプリ名>.json   ← AppSpec
  apps.md          ← アプリ ID の対応表
```

`apps.md` はこの形で保つ。あとで `update` するときに ID が要る。

```markdown
| アプリ | ID | AppSpec |
|---|---|---|
| 経費精算 | 123 | kintone/経費精算.json |
```

### 決まり

- **`plan` / `create` / `revise` は使わない。** 内部で Claude API を呼ぶため、
  ここから使うと二重にコストがかかる。AppSpec は自分で書く
- **必ず `--dry-run --json` で検証してからデプロイする。** 無料・高速・副作用ゼロ。
  終了コード 2 なら `error.issues` を読んで直す
- **`--json` を付ける。** stdout が JSON だけになる（人間向けの表示は stderr）
- `schema --json`（36,000 文字）は読まない。`schema`（4,600 文字）で足りる
- **デプロイしたら必ずアプリ ID を `kintone/apps.md` に記録する。**
  記録し忘れると、あとで直したくなったときに対象が分からなくなる

### 終了コード

| | 意味 | 次にすること |
|---|---|---|
| 0 | 成功 | |
| 2 | AppSpec が不正 | `error.issues` を読んで直す |
| 3 | 認証 | `.env` の `KINTONE_USERNAME` / `KINTONE_PASSWORD` を確認 |
| 4 | 設定不足 | `.env` を確認 |
| 5 | kintone API | 権限を確認、または時間をおいて再試行 |
| 7 | 引数の誤り | コマンドを見直す |

### 既存アプリを直すとき

アプリ ID は `kintone/apps.md` から引く。分からなければ人に聞く。

```bash
npx fieldsmith pull <appId> -o kintone/<アプリ名>.json   # 読み取りのみ
# 編集する
npx fieldsmith diff <appId> kintone/<アプリ名>.json      # 読み取りのみ
npx fieldsmith update <appId> kintone/<アプリ名>.json    # 動作テスト環境まで
```

- **既存フィールドの `code` と `type` は変えない。** 変えるとデータが引き継がれない
- フィールドを外したら `views` の `fields` からも外す
- `update` は既定で運用環境に出ない。反映は人が画面で確認してから `--deploy` を付ける

### やってはいけないこと

- **`deploy` を確認なしに繰り返さない。** 毎回新しいアプリが作られ、
  kintone にアプリ削除の API は無いので手作業で消すことになる
- 既存アプリを変えたいときに `deploy` を使わない（`update` を使う）
````

### `.claude/settings.json`

**読み取りだけのコマンドは確認なしで通し、kintone を変えるコマンドは毎回確認する。**

```json
{
  "permissions": {
    "allow": [
      "Bash(npx fieldsmith schema*)",
      "Bash(npx fieldsmith deploy * --dry-run*)",
      "Bash(npx fieldsmith pull *)",
      "Bash(npx fieldsmith diff *)",
      "Bash(npx fieldsmith status *)"
    ],
    "ask": [
      "Bash(npx fieldsmith deploy *)",
      "Bash(npx fieldsmith update *)"
    ]
  }
}
```

評価順は **`deny` → `ask` → `allow`**。先にマッチしたものが勝つ。
`deploy ... --dry-run` は `ask` の `deploy *` にもマッチしてしまうので、
上の書き方では確認が入る。**検証だけは確認なしで通したい**なら、
`ask` を絞る。

```json
{
  "permissions": {
    "allow": [
      "Bash(npx fieldsmith schema*)",
      "Bash(npx fieldsmith pull *)",
      "Bash(npx fieldsmith diff *)",
      "Bash(npx fieldsmith status *)"
    ],
    "ask": [
      "Bash(npx fieldsmith deploy *)",
      "Bash(npx fieldsmith update *)"
    ],
    "deny": [
      "Bash(npx fieldsmith plan *)",
      "Bash(npx fieldsmith create *)",
      "Bash(npx fieldsmith revise *)"
    ]
  }
}
```

`plan` / `create` / `revise` を `deny` に入れておくと、
「Claude Code から Claude API を二重に呼ぶ」事故を仕組みで防げる。

> `--dry-run` を確認なしで通したい場合は、`deploy` を `ask` に入れたうえで
> Claude Code に「検証には必ず `--dry-run` を付ける」と `CLAUDE.md` で指示する。
> ルールは前方一致のパターンなので、「`--dry-run` が付いていないときだけ確認」を
> 完全に表現することはできない。安全側（毎回確認）に倒すのが確実。

### ファイルの使い分け

| ファイル | 用途 | コミット |
|---|---|---|
| `.claude/settings.json` | プロジェクトで共有する設定 | する |
| `.claude/settings.local.json` | 個人・マシン固有 | しない（`.gitignore` へ）|

`.env`（kintone の認証情報）は当然コミットしない。

---

## まとめ

- `plan` / `create` / `revise` は使わない。AppSpec は Claude Code が自分で書く
- `schema` を読ませ、`deploy --dry-run --json` で回す（**資格情報なしで通る**）
- 認証はパスワード認証にして非対話にする
- `deploy` は毎回新しいアプリを作る。既存を直すなら `update`
- `update` は既定で運用環境に出ない。人が画面で確認してから `--deploy`
