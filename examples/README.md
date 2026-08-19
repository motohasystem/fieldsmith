# サンプル

そのまま `fieldsmith deploy` に渡せる AppSpec の実例。

```bash
fieldsmith deploy examples/案件管理.json --dry-run   # 送信内容を確認
fieldsmith deploy examples/案件管理.json             # 実際に作る
```

| ファイル | フィールド | 見どころ |
|---|---|---|
| [案件管理.json](案件管理.json) | 6 | いちばん小さい実例。`group` による横並び、絞り込み付きの一覧 |
| [書籍管理.json](書籍管理.json) | 10 | `unique`（重複禁止）、`LINK`、添付ファイル |
| [本棚.json](本棚.json) | 8 | マスタ側のアプリ。他アプリから参照される想定 |
| [蔵書管理.json](蔵書管理.json) | 18 | 頭文字アイコン（絵文字ではなく「蔵書」の文字）、多めの一覧 |
| [蔵書.json](蔵書.json) | 18 | 実運用に近い規模。5 つの一覧、`CALC`、意味でまとめた `group` |

いずれも環境に依存しない。作成先のスペースを指定したい場合は `--space <id>` を付けるか、
AppSpec に `"space": <id>` を足す。

## 文章から作る場合の入力例

[requirements-蔵書管理.md](requirements-蔵書管理.md) は `plan` に渡す要件の例。

```bash
fieldsmith plan -f examples/requirements-蔵書管理.md -o my-spec.json
```
