#!/usr/bin/env bash
#
# Cloudflare Workers へのデプロイを自動化する。何度実行しても同じ結果になる（冪等）。
#
#   ./scripts/deploy.sh              デプロイする
#   ./scripts/deploy.sh --dry-run    アップロードせずビルドと設定の検証だけ行う
#
# 環境変数:
#   SECRETS_FILE   シークレットを読むファイル（既定: .dev.vars / .env 形式）
#   OAUTH_KV_ID    KV ネームスペース ID を明示指定する（既定: 検索、無ければ作成）
#   KV_TITLE       検索/作成する KV ネームスペース名（既定: health-advisor-OAUTH_KV）
#   SKIP_TYPECHECK 1 なら tsc による型チェックを飛ばす
#
set -euo pipefail

cd "$(dirname "$0")/.."

SECRETS_FILE="${SECRETS_FILE:-.dev.vars}"
CONFIG_SRC="wrangler.jsonc"
CONFIG_OUT="wrangler.generated.jsonc"
PLACEHOLDER="<REPLACE_WITH_KV_NAMESPACE_ID>"
KV_BINDING="OAUTH_KV"
KV_TITLE="${KV_TITLE:-health-advisor-OAUTH_KV}"
REQUIRED_SECRETS=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET COOKIE_ENCRYPTION_KEY)

DRY_RUN=false

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m警告:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[31mエラー:\033[0m %s\n' "$1" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) die "不明な引数: $arg（--dry-run / --help）" ;;
  esac
done

# --- 1) 前提チェック ------------------------------------------------------
[ -f "$CONFIG_SRC" ] || die "$CONFIG_SRC が見つからない。リポジトリのルートで実行すること。"

if [ ! -d node_modules ]; then
  info "node_modules が無いのでインストールする"
  npm install
fi

if [ "$DRY_RUN" = false ]; then
  info "Cloudflare の認証を確認中..."
  if ! npx wrangler whoami >/dev/null 2>&1; then
    die "Cloudflare に未ログイン。\`npx wrangler login\` を実行するか、CLOUDFLARE_API_TOKEN を設定すること。"
  fi
fi

# --- 2) シークレットの検証（ドライランでは使わないので警告に留める） -------
if [ ! -f "$SECRETS_FILE" ]; then
  [ "$DRY_RUN" = true ] || die "$SECRETS_FILE が無い。\`./scripts/setup.sh\` を先に実行すること。"
  warn "$SECRETS_FILE が無いが、ドライランなので続行する"
else
  for key in "${REQUIRED_SECRETS[@]}"; do
    value="$(grep -E "^${key}=" "$SECRETS_FILE" | head -1 | cut -d= -f2- || true)"
    case "$value" in
      "")
        die "$SECRETS_FILE に $key が無い" ;;
      your-client-id*|your-client-secret*|replace-with*)
        die "$SECRETS_FILE の $key がサンプル値のまま" ;;
    esac
  done
  info "シークレット 3 件を $SECRETS_FILE から読み込む"
fi

# --- 3) 型チェック --------------------------------------------------------
if [ "${SKIP_TYPECHECK:-}" = "1" ]; then
  warn "型チェックを飛ばす (SKIP_TYPECHECK=1)"
else
  info "型チェック中..."
  npm run --silent typecheck
fi

# --- 4) KV ネームスペース ID の解決 ---------------------------------------
# wrangler kv namespace list はバナー無しの JSON 配列を返すので、それを検索する。
kv_lookup() {
  npx wrangler kv namespace list 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const start = raw.indexOf("[");
      if (start < 0) return;
      let namespaces;
      try {
        namespaces = JSON.parse(raw.slice(start));
      } catch {
        return;
      }
      for (const title of process.argv.slice(1)) {
        const hit = namespaces.find((ns) => ns.title === title);
        if (hit) {
          console.log(hit.id);
          return;
        }
      }
    });
  ' "$KV_TITLE" "$KV_BINDING"
}

CONFIG_USED="$CONFIG_SRC"

if grep -q "$PLACEHOLDER" "$CONFIG_SRC"; then
  if [ -n "${OAUTH_KV_ID:-}" ]; then
    kv_id="$OAUTH_KV_ID"
    info "KV ネームスペース: 環境変数 OAUTH_KV_ID を使う ($kv_id)"
  elif [ "$DRY_RUN" = true ]; then
    # ドライランでは Cloudflare 側に何も作らない。ID はビルド検証に使うだけのダミー。
    kv_id="0000000000000000000000000000dead"
    info "KV ネームスペース: ドライランのためダミー ID を使う"
  else
    info "KV ネームスペース \"$KV_TITLE\" を検索中..."
    kv_id="$(kv_lookup)"

    if [ -z "$kv_id" ]; then
      info "見つからないので新規作成する"
      npx wrangler kv namespace create "$KV_TITLE" >/dev/null
      kv_id="$(kv_lookup)"
      [ -n "$kv_id" ] || die "KV ネームスペースの作成後に ID を取得できなかった"
    fi
    info "KV ネームスペース ID: $kv_id"
  fi

  # 元の wrangler.jsonc は書き換えず、ID を埋めた設定を生成して使う。
  # （コメント付き jsonc をそのまま保てるので、clone 直後の状態を壊さない）
  sed "s|$PLACEHOLDER|$kv_id|" "$CONFIG_SRC" > "$CONFIG_OUT"
  CONFIG_USED="$CONFIG_OUT"
else
  info "$CONFIG_SRC に実 ID が入っているのでそのまま使う"
fi

# --- 5) デプロイ ----------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
  info "ドライラン（アップロードしない）"
  npx wrangler deploy --config "$CONFIG_USED" --dry-run
  info "検証のみ完了"
  exit 0
fi

info "デプロイ中..."
deploy_log="$(mktemp)"
trap 'rm -f "$deploy_log"' EXIT

# --secrets-file はシークレットをデプロイと同時に追加適用するので、
# 対話式の `wrangler secret put` を 3 回叩く必要が無くなる。
npx wrangler deploy \
  --config "$CONFIG_USED" \
  --secrets-file "$SECRETS_FILE" 2>&1 | tee "$deploy_log"

# --- 6) デプロイ後の手作業を案内 ------------------------------------------
worker_url="$(grep -oE 'https://[A-Za-z0-9._-]+\.workers\.dev' "$deploy_log" | head -1 || true)"
[ -n "$worker_url" ] || worker_url="https://<your-worker>.workers.dev"

cat <<NEXT

────────────────────────────────────────────────────────────
デプロイ完了: $worker_url

残りは Google Cloud Console と Claude 側の設定（自動化できない）:

  1. OAuth クライアントの承認済みリダイレクト URI に登録
       $worker_url/callback
  2. Claude Mobile / Web: 設定 → コネクタ → カスタムコネクタを追加
       $worker_url/sse
────────────────────────────────────────────────────────────

NEXT
