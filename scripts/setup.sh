#!/usr/bin/env bash
#
# 初回セットアップを自動化する。依存インストールと .dev.vars の生成まで行い、
# Google Cloud 側の手作業（Console でしかできない部分）は最後に案内する。
#
#   ./scripts/setup.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

DEV_VARS=".dev.vars"
DEV_VARS_EXAMPLE=".dev.vars.example"
REQUIRED_NODE_MAJOR=22

info()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn()  { printf '\033[33m警告:\033[0m %s\n' "$1" >&2; }
die()   { printf '\033[31mエラー:\033[0m %s\n' "$1" >&2; exit 1; }

# 1) Node のバージョン確認（wrangler v4 は Node 22 以上を要求する）
command -v node >/dev/null || die "node が見つからない。Node.js ${REQUIRED_NODE_MAJOR} 以上をインストールすること。"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt "$REQUIRED_NODE_MAJOR" ]; then
  die "Node.js ${REQUIRED_NODE_MAJOR} 以上が必要（現在: $(node -v)）"
fi
info "Node.js $(node -v)"

# 2) 依存インストール（.npmrc の legacy-peer-deps がそのまま効く）
if [ -d node_modules ]; then
  info "node_modules は既にある（再インストールするなら rm -rf node_modules）"
else
  info "依存をインストール中..."
  npm install
fi

# 3) .dev.vars を用意し、COOKIE_ENCRYPTION_KEY だけ自動生成する
if [ -f "$DEV_VARS" ]; then
  info "$DEV_VARS は既にある（上書きしない）"
else
  [ -f "$DEV_VARS_EXAMPLE" ] || die "$DEV_VARS_EXAMPLE が見つからない"

  if command -v openssl >/dev/null; then
    cookie_key="$(openssl rand -hex 32)"
  else
    cookie_key="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  fi

  sed "s|^COOKIE_ENCRYPTION_KEY=.*|COOKIE_ENCRYPTION_KEY=${cookie_key}|" \
    "$DEV_VARS_EXAMPLE" > "$DEV_VARS"
  chmod 600 "$DEV_VARS"
  info "$DEV_VARS を生成し、COOKIE_ENCRYPTION_KEY を自動生成した"
fi

# 4) 残りの手作業を案内する
missing_secret=false
for key in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  value="$(grep -E "^${key}=" "$DEV_VARS" | head -1 | cut -d= -f2- || true)"
  case "$value" in
    ""|your-client-id*|your-client-secret*) missing_secret=true ;;
  esac
done

echo
if [ "$missing_secret" = true ]; then
  warn "$DEV_VARS の GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET がまだ未設定"
  cat <<'GUIDE'

次の手順（Google Cloud Console での手作業）:

  1. Google Health API を有効化
  2. OAuth 同意画面を External / Testing で設定し、自分をテストユーザーに追加
  3. OAuth クライアント ID（ウェブアプリケーション）を作成し、
     承認済みリダイレクト URI に以下の両方を登録する
       ローカル: http://localhost:8787/callback
       本番:     https://<your-worker>.workers.dev/callback
  4. 発行された client ID / secret を .dev.vars に記入

  詳細は README.md の「セットアップ」を参照。

GUIDE
else
  info "秘密情報は設定済み"
fi

cat <<'NEXT'
セットアップ完了後:

  npm run dev            ローカル起動 (http://localhost:8787)
  npm run deploy:auto    Cloudflare へデプロイ

NEXT
