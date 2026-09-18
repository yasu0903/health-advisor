# Health Advisor — Google Health API 連携 MCP サーバー

自分の健康データ（Fitbit アカウント経由）を **Google Health API** から取得し、
Claude（Desktop / Mobile / Web）に読み取り専用で提供する MCP サーバーです。
**Cloudflare Workers** にデプロイでき、**ローカル（`wrangler dev`）でも同じコードで動作**します。

- データ源: **Fitbit アカウント**（Pixel Watch も可）
- 取得対象: **アクティビティ全般 + 睡眠**（読み取り専用）
- API: `https://health.googleapis.com/v4`（Google Fit REST API の後継。Fit は 2026 年末終了）

> ⚠️ **Health Connect は Android 端末内オンリー（クラウド REST なし）** のため使いません。
> クラウドからデータを引ける **Google Health API** を採用しています。

> 🚧 **Status: experimental（実験段階）**
> Google Health API の実データに対する検証はこれからの段階です。`src/mcp.ts` の
> データ型 ID や時間クエリ名は[公式リファレンス](https://developers.google.com/health/reference/rest)
> に合わせて調整が必要な場合があります。**セルフホストの個人利用**を前提としています。

---

## 提供する MCP ツール（すべて読み取り専用）

| ツール | 説明 |
| --- | --- |
| `list_available_data_types` | 取得可能なデータ型と対応メソッドの一覧 |
| `get_daily_activity_summary` | 日次サマリ（歩数/距離/カロリー/アクティブ時間/階数）を `dailyRollUp` で取得 |
| `get_activity_datapoints` | 任意のアクティビティ型を柔軟に取得（`list`/`reconcile`/`rollUp`/`dailyRollUp`） |
| `get_heart_rate` | 心拍データ（`list`/`rollUp`） |
| `get_sleep_logs` | 睡眠ログ（睡眠ステージ含む） |

---

## セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. Google Cloud 側の準備

1. [Google Cloud Console](https://console.cloud.google.com/) で新規プロジェクトを作成
2. **Google Health API** を有効化（API とサービス → ライブラリ → "Health"）
3. **OAuth 同意画面**を構成
   - User Type: **External**
   - 公開ステータス: **テスト（Testing）**
   - **テストユーザーに自分の Google アカウントを追加**
   - スコープに以下を追加:
     - `.../auth/googlehealth.activity_and_fitness.readonly`
     - `.../auth/googlehealth.sleep.readonly`
     - `openid` / `email` / `profile`
4. **OAuth クライアント ID** を作成（種別: **ウェブアプリケーション**）
   - 承認済みリダイレクト URI に**両方**を登録:
     - ローカル: `http://localhost:8788/callback`
     - 本番: `https://<your-worker>.workers.dev/callback`
   - 発行された **クライアント ID / シークレット**を控える

> ℹ️ `googlehealth.*` は全て **Restricted スコープ**。本番公開には Google の審査が必要ですが、
> **「テスト」ステータス + テストユーザー登録なら審査なしで個人利用できます**。
> ただし **テストステータスではリフレッシュトークンが 7 日で失効**するため、
> 定期的に再認証が必要です（長期運用は OAuth 審査申請を検討）。

### 3. 秘密情報の設定

```bash
cp .dev.vars.example .dev.vars
# .dev.vars を編集して GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / COOKIE_ENCRYPTION_KEY を記入
# COOKIE_ENCRYPTION_KEY は: openssl rand -hex 32
```

### 4. KV ネームスペース作成（本番デプロイ時）

```bash
npx wrangler kv namespace create OAUTH_KV
# 出力された id を wrangler.jsonc の kv_namespaces[].id に貼る
```

ローカルの `wrangler dev` はローカルエミュレートされた KV を使うため、
疎通確認だけなら id はダミーのままでも動きます。

---

## ローカルで動かす

```bash
npm run dev          # = wrangler dev, http://localhost:8788
```

### MCP Inspector で疎通確認

```bash
npm run inspector    # = npx @modelcontextprotocol/inspector
```

Inspector で `http://localhost:8788/sse` に接続 → Google のログイン/同意を完了 → 各ツールを実行。

### Claude Desktop（ローカルサーバーに接続）

設定 → Developer → Edit Config に追記して再起動:

```json
{
  "mcpServers": {
    "health-advisor": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8788/sse"]
    }
  }
}
```

---

## Cloudflare にデプロイ

```bash
# 秘密情報を本番に登録
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY

npm run deploy
```

デプロイ後:

1. Google Cloud の OAuth クライアントの承認済みリダイレクト URI に
   `https://<your-worker>.workers.dev/callback` が入っていることを確認
2. **Claude Mobile / Web**: 設定 → コネクタ → **カスタムコネクタを追加** →
   `https://<your-worker>.workers.dev/sse` を登録 → OAuth ログイン
3. **Claude Desktop（本番接続）**: 上記 config の URL を本番 URL に変更

---

## 動作確認

Claude に以下のように尋ねる:

> 昨日の歩数と睡眠時間を教えて

`get_daily_activity_summary` と `get_sleep_logs` が呼ばれ、Fitbit のデータが返れば成功です。

---

## 実装メモ・既知の注意点

- **データ型 ID の確定**: `src/mcp.ts` の `DATA_TYPES` にある `dataType` 文字列は、
  実データ疎通時に [Google Health API リファレンス](https://developers.google.com/health/reference/rest)
  に合わせて確認・調整してください（この表を直すだけで全ツールに反映されます）。
- **クエリパラメータ名**: `src/google-health.ts` は時間範囲パラメータを呼び出し側から
  自由に渡せる設計です。API の仕様に合わせて `src/mcp.ts` 側で調整できます。
- **レート制限**: 公式に非公開のため、クライアントは指数バックオフ付きリトライを実装しています。
  初期はツール呼び出し頻度を控えめに。
- **Fitbit → Google 連携**: データが Google Health API に現れるには、
  Fitbit アカウントが Google と連携している必要がある場合があります。

## ファイル構成

```
src/
  index.ts          OAuthProvider の配線
  google-handler.ts Google OAuth (authorize / callback)
  mcp.ts            McpAgent と読み取り専用ツール
  google-health.ts  Google Health API クライアント
  types.ts          共有型
wrangler.jsonc      Worker 設定
```

---

## Google API 利用上の前提（重要）

- `googlehealth.*` は **Restricted スコープ**です。**利用者ごとに自分の Google Cloud
  プロジェクトと OAuth クライアントを用意**し、OAuth 同意画面を **「テスト」モード**にして
  **自分自身をテストユーザー**に登録する、**セルフホストの個人利用**を想定しています。
- **不特定多数に使わせる形で公開デプロイする場合は、Google のセキュリティ審査（アセスメント）が
  別途必要**になります。各自の責任で Google の規約・ポリシーを確認してください。
- テストモードでは**リフレッシュトークンが 7 日で失効**します（定期的な再認証が必要）。

## セキュリティ上の既知の制限

本実装は**個人によるセルフホスト利用**を想定しています。マルチユーザーで公開運用する場合は、
最低限以下のハードニングを推奨します（PR 歓迎）:

- OAuth の `state` は現状 base64 エンコードのみで**署名（改ざん検知・CSRF 対策）がありません**。
- 認可時の**同意ダイアログを省略（自動承認）**しています。
- Google のアクセストークン/リフレッシュトークンは KV / セッションに保存されます。運用環境の
  アクセス管理・機密管理は利用者の責任です。

## 免責事項 / Disclaimer

- 本ソフトウェアは **MIT ライセンス**で「**現状のまま（AS IS）／無保証**」で提供されます。
  利用によって生じたいかなる損害についても作者は責任を負いません（詳細は `LICENSE`）。
- 本ソフトウェアが提供する健康データや、それに基づく Claude の応答は
  **医療上の助言・診断・治療ではありません**。健康に関する判断は必ず医療専門家に相談してください。
- 取得・保存される健康データはあなた自身の機微情報です。**データの取り扱い・プライバシー・
  各種法令の遵守は利用者の責任**で行ってください。

## コントリビューション

Issue / PR を歓迎します。特にデータ型 ID の検証、対応データ型の追加、セキュリティ強化は歓迎です。

## ライセンス

[MIT License](./LICENSE) © 2026 yasuch
