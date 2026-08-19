# セットアップ: OAuth

OAuth クライアントを登録して認可する。**パスワードを設定ファイルに置かずに済む。**

- パスワードを配りたくない・置きたくないとき
- 誰の権限で動いているかを kintone 側で管理したいとき

手早く試したいだけなら [パスワード認証](setup-password.md) のほうが早い（登録も認可も不要）。

---

## 必要なもの

- Node.js 20 以上
- kintone のアカウント（**アプリの作成権限**が要る）
- **cybozu.com 共通管理の権限**（OAuth クライアントを登録するため）

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

## 2. OAuth クライアントを登録する

cybozu.com 共通管理 → 外部サービス連携 → **OAuth クライアント** → 追加。

| 項目 | 値 |
|---|---|
| クライアント名 | `fieldsmith` など |
| リダイレクトエンドポイント | 転送先の URL。例: `https://example.com/callback` |

> リダイレクト先のページは**実在しなくてよい**。fieldsmith は転送先の URL を手で貼り付ける方式なので、
> ブラウザがそこへ飛んだときにアドレスバーの URL さえ読めればよい。

保存すると次の 4 つが払い出される。

- クライアント ID
- クライアントシークレット
- 認可エンドポイント URL
- トークンエンドポイント URL

## 3. 認証情報を書く

```bash
cp .env.example .env
```

`.env` に、払い出された値をそのまま写す。

```bash
KINTONE_BASE_URL=https://<サブドメイン>.cybozu.com
KINTONE_OAUTH_CLIENT_ID=...
KINTONE_OAUTH_CLIENT_SECRET=...
KINTONE_OAUTH_REDIRECT_URI=https://example.com/callback
KINTONE_OAUTH_AUTHORIZATION_ENDPOINT=...
KINTONE_OAUTH_TOKEN_ENDPOINT=...
```

`KINTONE_OAUTH_REDIRECT_URI` は、**2 で登録したものと完全に一致**していないと弾かれる。

## 4. 認可する

```bash
fieldsmith login
```

1. 表示された URL をブラウザで開く
2. 内容を確認して許可する
3. リダイレクト先に飛んだら、**アドレスバーの URL をそのままコピーして貼り付ける**
   （ページが「見つかりません」でも構わない。URL さえ取れればよい）

要求されるスコープは 3 つ。

| スコープ | 用途 |
|---|---|
| `k:app_settings:write` | アプリ作成、フィールド追加、運用環境への反映 |
| `k:app_settings:read` | **反映状況の確認** |
| `k:file:write` | **アプリアイコンの画像アップロード** |

> `k:app_settings:read` を忘れると、書き込みが全部成功したあと
> 最後の反映状況の確認だけが `403 CB_OA01` で落ちる。
> fieldsmith は保存済みトークンのスコープを起動時に検査するので、
> 足りなければ 1 リクエストも投げずに止まる。

成功するとこう出る。

```
✓ https://<サブドメイン>.cybozu.com の認証情報を保存しました。
  アクセストークンは 1 時間で失効しますが、以降は自動で更新されます。
```

トークンは `~/.config/fieldsmith/tokens.json`（パーミッション 0600）に保存される。
リフレッシュトークンには有効期限が無いので、**再ログインは基本的に不要**。

## 5. 繋がることを確かめる

```bash
fieldsmith --verbose status 1
```

```
  接続先: https://<サブドメイン>.cybozu.com (OAuth)
```

アプリ 1 が存在しなければその後にエラーが出るが、ここでは気にしなくてよい。

### うまくいかないとき

| 表示 | 原因 |
|---|---|
| `state が一致しません` | 貼り付けた URL が別の認可のもの。`fieldsmith login` からやり直す |
| `URL に認可コード (code) が含まれていません` | リダイレクト先の URL ではなく認可 URL を貼っている |
| `HTTP 400 … invalid_grant` | 認可コードの有効期限は 10 分。時間をおきすぎた場合はやり直す |
| `保存済みの認証情報にスコープ … が含まれていません` | 古いトークン。`fieldsmith login` をやり直す |
| `403 CB_OA01` | スコープ不足。`fieldsmith login` をやり直す |

---

## 次へ

**[お試し手順書](walkthrough.md)** へ進む。第 2 部の「認証を確かめる」は済んでいるので飛ばしてよい。

### 覚えておくこと

- トークンを破棄するときは `fieldsmith logout`
- CI やエージェントから使う場合、`fieldsmith login` はブラウザが要るので人が一度やる必要がある。
  完全に非対話にしたいなら [パスワード認証](setup-password.md) を選ぶ
