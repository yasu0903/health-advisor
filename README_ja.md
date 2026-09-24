# Health Advisor — Google Health API 連携 MCP サーバー

[English](./README.md) | **日本語**

自分の健康データ（Fitbit アカウント経由）を **Google Health API** から取得して
Claude（Desktop / Mobile / Web）に提供し、加えて食事ログの登録ができる MCP サーバーです。
**Cloudflare Workers** にデプロイでき、**ローカル（`wrangler dev`）でも同じコードで動作**します。

- データ源: **Fitbit アカウント**（Pixel Watch も可）
- 取得対象: **アクティビティ全般 + 睡眠**（読み取り専用）、**食事ログ**（読み取り + 登録）
- API: `https://health.googleapis.com/v4`（Google Fit REST API の後継。Fit は 2026 年末終了）

> ⚠️ **Health Connect は Android 端末内オンリー（クラウド REST なし）** のため使いません。
> クラウドからデータを引ける **Google Health API** を採用しています。

> 🚧 **Status: experimental（実験段階）**
> エンドポイントとデータ型 ID は公式 discovery ドキュメント (revision 20260916) に
> 突き合わせ済みですが、実データでの全ツール検証は道半ばです。
> **セルフホストの個人利用**を前提としています。

---

## 提供する MCP ツール

`log_meal` だけが書き込みツールで、それ以外はすべて読み取り専用です。

| ツール | 説明 |
| --- | --- |
| `list_available_data_types` | 取得可能なデータ型と対応メソッドの一覧 |
| `get_daily_activity_summary` | 日次サマリ（歩数/距離/カロリー/アクティブ時間/階数）を `dailyRollUp` で取得 |
| `get_activity_datapoints` | 任意のアクティビティ型を柔軟に取得（`list`/`reconcile`/`rollUp`/`dailyRollUp`） |
| `get_heart_rate` | 心拍データ（`list`/`rollUp`） |
| `get_sleep_logs` | 睡眠ログ（睡眠ステージ含む） |
| `log_meal` | 食事ログ（`nutrition-log`）を Google Health に**登録**（カロリー・栄養素つき） |
| `list_meal_logs` | このサーバー経由で登録した食事ログを参照 |

---

## セットアップ

### クイックスタート

```bash
./scripts/setup.sh    # = npm run setup（依存インストール + .dev.vars 生成）
```

Google Cloud 側の準備（次の「2.」）だけは Console での手作業が必要です。
以下の 1 / 3 / 4 はスクリプトが肩代わりするので、中身を知りたい場合だけ読んでください。

### 1. 依存インストール

```bash
npm install
```

> `./scripts/setup.sh` が自動で実行します。

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
     - `.../auth/googlehealth.nutrition.writeonly`（食事ログ登録用）
     - `openid` / `email` / `profile`
4. **OAuth クライアント ID** を作成（種別: **ウェブアプリケーション**）
   - 承認済みリダイレクト URI に**両方**を登録:
     - ローカル: `http://localhost:8787/callback`
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

> `./scripts/setup.sh` が `.dev.vars` を生成し、`COOKIE_ENCRYPTION_KEY` も自動生成します
> （既存の `.dev.vars` は上書きしません）。クライアント ID / シークレットだけ記入してください。

### 4. KV ネームスペース作成（本番デプロイ時）

```bash
npx wrangler kv namespace create OAUTH_KV
# 出力された id を wrangler.jsonc の kv_namespaces[].id に貼る
```

> `./scripts/deploy.sh` が「既存を検索 → 無ければ作成 → id を埋めた設定を生成」まで
> 自動でやるので、手動で貼る必要はありません（`wrangler.jsonc` も書き換えません）。

ローカルの `wrangler dev` はローカルエミュレートされた KV を使うため、
疎通確認だけなら id はダミーのままでも動きます。

---

## ローカルで動かす

```bash
npm run dev          # = wrangler dev, http://localhost:8787
```

### MCP Inspector で疎通確認

```bash
npm run inspector    # = npx @modelcontextprotocol/inspector
```

Inspector (`http://localhost:6274`) で **Add server** → Transport に `streamable-http`、
URL に `http://localhost:8787/mcp` を指定して接続 → Google のログイン/同意を完了 → 各ツールを実行。

> `/sse` も残していますが、Inspector 上では SSE は非推奨表示になります。新規は `/mcp` を使ってください。

### Claude Desktop（ローカルサーバーに接続）

設定 → Developer → Edit Config に追記して再起動:

```json
{
  "mcpServers": {
    "health-advisor": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8787/sse"]
    }
  }
}
```

---

## Cloudflare にデプロイ

```bash
npm run deploy:auto     # = ./scripts/deploy.sh
```

このスクリプトは以下を順に実行します（何度実行しても同じ結果になります）:

1. Cloudflare へのログイン状態を確認
2. `.dev.vars` に必要な 3 つのシークレットが揃っているか検証
3. `npm run typecheck`（型エラーのあるコードをデプロイしない）
4. KV ネームスペースを検索し、無ければ作成して id を解決
5. id を埋めた `wrangler.generated.jsonc` を生成（`wrangler.jsonc` は変更しない）
6. `wrangler deploy --secrets-file` でシークレットごとアップロード
7. 払い出された URL と、この後必要な手作業を表示

アップロードせず検証だけしたい場合:

```bash
npm run deploy:check    # = ./scripts/deploy.sh --dry-run
```

主な環境変数:

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `SECRETS_FILE` | `.dev.vars` | シークレットを読むファイル（`.env` 形式）。本番用に分けるなら `.env.production` など |
| `OAUTH_KV_ID` | （自動解決） | KV ネームスペース ID を明示指定する |
| `KV_TITLE` | `health-advisor-OAUTH_KV` | 検索/作成する KV ネームスペース名 |
| `SKIP_TYPECHECK` | — | `1` で型チェックを飛ばす |

<details>
<summary>手動でデプロイする場合</summary>

```bash
# wrangler.jsonc の kv_namespaces[].id を実 id に書き換えたうえで
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY

npm run deploy
```

</details>

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

食事ログを確認するには、以下のように尋ねます:

> 今日の昼に鮭のおにぎり 180kcal を記録して。そのあと今日記録した分を見せて

`log_meal` で登録し、`list_meal_logs` で読み戻せれば成功です。

> ℹ️ 食事ログ機能の追加前に認可済みだった場合、既存のトークンには `nutrition.writeonly`
> スコープが含まれないため `log_meal` は権限エラーになります。OAuth 同意画面に新しい
> スコープを追加した上で、Claude 側でサーバーを再接続して再認可してください。

---

## 実装メモ・既知の注意点

- **エンドポイントの正**: 実装は公式 discovery ドキュメント
  (`https://health.googleapis.com/$discovery/rest?version=v4`) の定義に従っています。
  メソッドごとに HTTP メソッドとパラメータの渡し方が異なる点に注意:

  | メソッド | HTTP | パス | 範囲指定 |
  | --- | --- | --- | --- |
  | `list` | GET | `.../dataPoints` | `filter` クエリ |
  | `reconcile` | GET | `.../dataPoints:reconcile` | `filter` クエリ |
  | `rollUp` | POST | `.../dataPoints:rollUp` | ボディ `{range, windowSize}` |
  | `dailyRollUp` | POST | `.../dataPoints:dailyRollUp` | ボディ `{range, windowSizeDays}` |
  | `create` | POST | `.../dataPoints` | ボディ `DataPoint`（`log_meal` が使用） |

  `list` はコロン付きサブメソッドではなくコレクションへの素の GET です
  (`dataPoints:list` というルートは存在せず 404 になります)。
- **フィルタ式のフィールド名**: URL パスは kebab-case (`heart-rate`)、
  AIP-160 のフィルタ式は snake_case (`heart_rate.sample_time.physical_time`) を使います。
  期間を持つ型は `{type}.interval.start_time`、瞬間値は `{type}.sample_time.physical_time`。
  **睡眠だけは開始時刻で絞り込めず** `sleep.interval.end_time` を使います。
  **睡眠と ECG 以外のセッション型**（`nutrition-log` など）は
  `{type}.interval.civil_start_time` でしか絞り込めません。これはタイムゾーンを持たない
  **暦時刻**で、物理時刻は受け付けられないため、`list_meal_logs` はローカル日付を受け取ります。
- **ページサイズ**: `sleep` と `exercise` は最大 25 件、その他のデータ型は最大 10000 件です。
- **レート制限**: 公式に非公開のため、クライアントは指数バックオフ付きリトライを実装しています。
  初期はツール呼び出し頻度を控えめに。ただし**書き込みは自動リトライしません**。
  実際には成功していた create を再送すると二重登録になり得るためです。
  `log_meal` に `dataPointId` を渡せば、同じ ID での再実行が冪等になります。
- **食事ログの注意点**:
  - API の食事ログは *identified food*（`food` に `Food` リソース名を渡す）か
    *anonymous food*（`foodName` と栄養素を自分で埋める）のどちらかで作ります。
    v4 には `Food` を検索・作成するメソッドが無いため、`log_meal` は通常
    anonymous food として登録します。
  - **anonymous food で登録したログは後から編集できません**（本サーバーの制限ではなく
    API の仕様）。訂正したい場合は登録し直しになります。
  - `log_meal` の `eatenAt` はタイムゾーン必須です。API のセッション区間が UTC オフセットを
    必須としており、サーバー側で推測できないためです。
  - たんぱく質には API 上の専用フィールドが無いため `nutrients[PROTEIN]` として送ります。
  - **`googlehealth.nutrition.readonly` というスコープは存在しません。**
    `nutrition-log` の読み取りは `nutrition.writeonly` で許可され、これは自アプリが
    書き込んだデータを対象とします。したがって `list_meal_logs` で見えるのは
    このサーバー経由で登録した食事ログで、他アプリで記録した食事は含まれません。
- **Fitbit → Google 連携**: データが Google Health API に現れるには、
  Fitbit アカウントが Google と連携している必要がある場合があります。

## ファイル構成

```
src/
  index.ts          OAuthProvider の配線
  google-handler.ts Google OAuth (authorize / callback)
  mcp.ts            McpAgent とツール定義
  google-health.ts  Google Health API クライアント
  nutrition.ts      食事ログ（nutrition-log）のペイロード組み立て
  types.ts          共有型
scripts/
  setup.sh          初回セットアップ（依存インストール + .dev.vars 生成）
  deploy.sh         デプロイ自動化（KV 解決 + 型チェック + シークレット投入 + deploy）
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
