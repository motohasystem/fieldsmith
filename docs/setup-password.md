# セットアップ: パスワード認証

kintone のログイン名とパスワードで繋ぐ。**事前の登録も認可の手続きも要らない。**

- 手早く試したいとき
- CI やエージェントから使うとき（人の手が一切要らない）

パスワードを設定ファイルに置きたくない場合は [OAuth](setup-oauth.md) を選ぶ。

---

## 必要なもの

- Node.js 20 以上
- kintone のアカウント（**アプリの作成権限**が要る）

## 1. インストール

```bash
git clone https://github.com/motohasystem/fieldsmith.git
cd fieldsmith
npm install
npm run build
```

以降 `fieldsmith` と書くところは `npm run fieldsmith --` に読み替える。

```bash
npm run fieldsmith -- schema      # = fieldsmith schema
```

## 2. 認証情報を書く

```bash
cp .env.example .env
```

`.env` に 3 行書く。

```bash
KINTONE_BASE_URL=https://<サブドメイン>.cybozu.com
KINTONE_USERNAME=<ログイン名>
KINTONE_PASSWORD=<パスワード>
```

> `.env` は `.gitignore` 済みなのでコミットされないが、共有マシンでは注意する。

OAuth の設定も残っている場合はパスワード認証が優先される。
明示したいときは `KINTONE_AUTH=password` を足す。

## 3. 繋がることを確かめる

```bash
fieldsmith --verbose status 1
```

```
  接続先: https://<サブドメイン>.cybozu.com (パスワード認証: taro)
```

**接続先と認証方式が想定どおりなら成功。**
アプリ 1 が存在しなければその後にエラーが出るが、ここでは気にしなくてよい。

### うまくいかないとき

| 表示 | 原因 |
|---|---|
| `kintone の認証情報が設定されていません` | `.env` の 3 行が読めていない。`fieldsmith` をリポジトリ直下で実行しているか確認する |
| `認証に失敗しました。KINTONE_USERNAME と KINTONE_PASSWORD を確認してください` | ログイン名かパスワードが違う |
| `KINTONE_BASE_URL は URL 形式で指定してください` | `https://` から書く |

---

## 次へ

**[お試し手順書](walkthrough.md)** へ進む。第 2 部の「認証を確かめる」は済んでいるので飛ばしてよい。

### 覚えておくこと

- **`fieldsmith login` は要らない。** 実行すると「認可の手続きは要りません」と表示されて止まる
- 保存されるものが無いので、やめるときは `.env` の 2 行を消すだけ
