#!/usr/bin/env bash
#
# fieldsmith をどこからでも同じ書き方で呼ぶためのラッパー。
#
# やることは 2 つ。
#
#   1. fieldsmith 本体を見つける
#        a. PATH の fieldsmith（グローバルインストール済み）
#        b. FIELDSMITH_DIR が指すリポジトリのソース（開発時のみ。tsx で直接実行）
#        c. npx -y fieldsmith（npm 公開版。既定の経路）
#
#   2. .env を見つけて読み込む
#      fieldsmith 本体は cwd の .env しか読まない。エージェントの cwd は
#      kintone の設定を置いた場所とは限らないので、ここで探して環境変数に入れる。
#        a. すでに KINTONE_BASE_URL が環境にあるなら何もしない
#        b. FIELDSMITH_ENV が指すファイル
#        c. cwd から上へ辿って最初に見つかった .env（$HOME まで）
#        d. ${XDG_CONFIG_HOME:-~/.config}/fieldsmith/.env
#
# cwd は変えないので、spec ファイルは相対パスで渡してよい。
#
# 環境変数:
#   FIELDSMITH_DIR       開発中のリポジトリの場所（ソースを直接実行する）
#   FIELDSMITH_ENV       .env のパスを明示する
#   FIELDSMITH_USE_NPX=1 PATH に fieldsmith があっても npm 公開版を使う
set -euo pipefail

# ---------------------------------------------------------------- .env を読む

# `KEY=VALUE` だけを解釈する。すでに環境にある変数は上書きしない
# （CI での注入を優先する。fieldsmith 本体の loadDotEnv と同じ方針）。
load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"          # 先頭の空白を落とす
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ -z "$key" ]] && continue

    value="${value#"${value%%[![:space:]]*}"}"       # 前後の空白
    value="${value%"${value##*[![:space:]]}"}"
    # 引用符で囲まれていれば外す
    if [[ ${#value} -ge 2 ]]; then
      if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi

    [[ -n "${!key+x}" ]] && continue                 # すでにあるものは触らない
    export "$key=$value"
  done < "$file"
  return 0
}

find_env_file() {
  if [[ -n "${FIELDSMITH_ENV:-}" ]]; then
    printf '%s\n' "$FIELDSMITH_ENV"
    return
  fi

  local dir
  dir="$(pwd -P)"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/.env" ]]; then
      printf '%s\n' "$dir/.env"
      return
    fi
    [[ "$dir" == "$HOME" ]] && break
    dir="$(dirname "$dir")"
  done

  printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fieldsmith/.env"
}

# 認証が要らない操作（schema / --dry-run など）でも読み込んで構わない。
# 見つからなければ黙って進む。本体が必要なときに config エラーを出す。
if [[ -z "${KINTONE_BASE_URL:-}" ]]; then
  load_env_file "$(find_env_file)" || true
fi

# ------------------------------------------------------------ 本体を見つける

if [[ "${FIELDSMITH_USE_NPX:-}" != "1" ]]; then
  if command -v fieldsmith >/dev/null 2>&1; then
    exec fieldsmith "$@"
  fi

  # 開発時だけの経路。明示的に指した場合のみ使う。
  repo="${FIELDSMITH_DIR:-}"
  if [[ -n "$repo" && -f "$repo/package.json" ]]; then
    if [[ -x "$repo/node_modules/.bin/tsx" ]]; then
      exec "$repo/node_modules/.bin/tsx" "$repo/src/cli/index.ts" "$@"
    fi
    if [[ -f "$repo/dist/cli/index.js" ]]; then
      exec node "$repo/dist/cli/index.js" "$@"
    fi
    echo "FIELDSMITH_DIR=$repo にビルド済みの dist も tsx も見つかりません。" >&2
    echo "リポジトリで npm install するか、FIELDSMITH_DIR を外して npm 公開版を使ってください。" >&2
    exit 7
  fi
fi

exec npx -y fieldsmith "$@"
