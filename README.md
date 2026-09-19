# Health Advisor — an MCP server for the Google Health API

**English** | [日本語](./README_ja.md)

An MCP server that reads your own health data (via your Fitbit account) from the
**Google Health API** and exposes it read-only to Claude (Desktop / Mobile / Web).
It deploys to **Cloudflare Workers** and **runs locally from the same code** with `wrangler dev`.

- Data source: **your Fitbit account** (Pixel Watch works too)
- Coverage: **general activity + sleep** (read-only)
- API: `https://health.googleapis.com/v4` (successor to the Google Fit REST API, which shuts down at the end of 2026)

> ⚠️ **Health Connect is on-device only on Android (no cloud REST API)**, so it is not used here.
> This project uses the **Google Health API**, which can serve data from the cloud.

> 🚧 **Status: experimental**
> Endpoints and data type IDs have been checked against the official discovery document
> (revision 20260916), but end-to-end verification of every tool against real data is still
> in progress. This is intended for **self-hosted personal use**.

---

## MCP tools (all read-only)

| Tool | Description |
| --- | --- |
| `list_available_data_types` | Lists the available data types and the methods each one supports |
| `get_daily_activity_summary` | Daily summary (steps / distance / calories / active minutes / floors) via `dailyRollUp` |
| `get_activity_datapoints` | Flexible access to any activity type (`list` / `reconcile` / `rollUp` / `dailyRollUp`) |
| `get_heart_rate` | Heart rate data (`list` / `rollUp`) |
| `get_sleep_logs` | Sleep logs, including sleep stages |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Prepare your Google Cloud project

1. Create a new project in the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Health API** (APIs & Services → Library → search for "Health")
3. Configure the **OAuth consent screen**
   - User type: **External**
   - Publishing status: **Testing**
   - **Add your own Google account as a test user**
   - Add these scopes:
     - `.../auth/googlehealth.activity_and_fitness.readonly`
     - `.../auth/googlehealth.sleep.readonly`
     - `openid` / `email` / `profile`
4. Create an **OAuth client ID** (type: **Web application**)
   - Register **both** authorized redirect URIs:
     - Local: `http://localhost:8787/callback`
     - Production: `https://<your-worker>.workers.dev/callback`
   - Keep the issued **client ID / client secret**

> ℹ️ All `googlehealth.*` scopes are **restricted scopes**. Publishing to production requires
> Google's review, but you can use them for **personal use without review** by keeping the app in
> **Testing** status and registering yourself as a test user.
> Note that **in Testing status refresh tokens expire after 7 days**, so you have to re-authenticate
> periodically (for long-running setups, consider applying for OAuth verification).

### 3. Configure secrets

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars and fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / COOKIE_ENCRYPTION_KEY
# Generate COOKIE_ENCRYPTION_KEY with: openssl rand -hex 32
```

### 4. Create a KV namespace (for production deployments)

```bash
npx wrangler kv namespace create OAUTH_KV
# Paste the returned id into kv_namespaces[].id in wrangler.jsonc
```

`wrangler dev` uses a locally emulated KV store, so a dummy id is fine if you only want to try
things out locally.

---

## Running locally

```bash
npm run dev          # = wrangler dev, http://localhost:8787
```

### Smoke-testing with the MCP Inspector

```bash
npm run inspector    # = npx @modelcontextprotocol/inspector
```

In the Inspector (`http://localhost:6274`), choose **Add server**, set the transport to
`streamable-http` and the URL to `http://localhost:8787/mcp`, connect, complete the Google
sign-in/consent flow, then run the tools.

> `/sse` is still available, but the Inspector marks SSE as deprecated. Use `/mcp` for new setups.

### Claude Desktop (connecting to the local server)

Add this in Settings → Developer → Edit Config, then restart:

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

## Deploying to Cloudflare

```bash
# Register the secrets for production
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY

npm run deploy
```

After deploying:

1. Make sure `https://<your-worker>.workers.dev/callback` is listed as an authorized redirect URI
   on your Google Cloud OAuth client
2. **Claude Mobile / Web**: Settings → Connectors → **Add custom connector** →
   register `https://<your-worker>.workers.dev/sse` → sign in with OAuth
3. **Claude Desktop (production)**: change the URL in the config above to your production URL

---

## Verifying it works

Ask Claude something like:

> How many steps did I take yesterday, and how long did I sleep?

If `get_daily_activity_summary` and `get_sleep_logs` are called and return your Fitbit data,
you're all set.

---

## Implementation notes and known caveats

- **Source of truth for endpoints**: the implementation follows the official discovery document
  (`https://health.googleapis.com/$discovery/rest?version=v4`). Note that the HTTP method and the
  way the time range is passed differ per method:

  | Method | HTTP | Path | Range |
  | --- | --- | --- | --- |
  | `list` | GET | `.../dataPoints` | `filter` query parameter |
  | `reconcile` | GET | `.../dataPoints:reconcile` | `filter` query parameter |
  | `rollUp` | POST | `.../dataPoints:rollUp` | body `{range, windowSize}` |
  | `dailyRollUp` | POST | `.../dataPoints:dailyRollUp` | body `{range, windowSizeDays}` |

  `list` is a plain GET on the collection, not a colon-suffixed sub-method
  (there is no `dataPoints:list` route — it returns 404).
- **Field names in filter expressions**: URL paths use kebab-case (`heart-rate`), while AIP-160
  filter expressions use snake_case (`heart_rate.sample_time.physical_time`). Types with a duration
  use `{type}.interval.start_time`; instantaneous types use `{type}.sample_time.physical_time`.
  **Sleep is the exception**: it cannot be filtered by start time, so `sleep.interval.end_time` is used.
- **Page size**: `sleep` and `exercise` are capped at 25 items; other data types allow up to 10000.
- **Rate limits**: they are not publicly documented, so the client implements retries with
  exponential backoff. Keep tool calls infrequent at first.
- **Fitbit → Google linkage**: your Fitbit account may need to be linked to Google before its data
  shows up in the Google Health API.

## Project layout

```
src/
  index.ts          OAuthProvider wiring
  google-handler.ts Google OAuth (authorize / callback)
  mcp.ts            McpAgent and the read-only tools
  google-health.ts  Google Health API client
  types.ts          shared types
wrangler.jsonc      Worker configuration
```

---

## Google API usage assumptions (important)

- `googlehealth.*` are **restricted scopes**. This project assumes **self-hosted personal use**:
  each user brings **their own Google Cloud project and OAuth client**, keeps the consent screen in
  **Testing** mode, and registers **themselves as a test user**.
- **If you deploy this publicly for arbitrary users, you will need Google's separate security
  assessment.** Reviewing Google's terms and policies is your own responsibility.
- In Testing mode, **refresh tokens expire after 7 days** (periodic re-authentication required).

## Known security limitations

This implementation targets **personal, self-hosted use**. If you run it publicly for multiple
users, the following hardening is recommended at minimum (PRs welcome):

- The OAuth `state` is only base64-encoded and **is not signed** (no tamper detection / CSRF protection).
- The **consent dialog is skipped (auto-approved)** during authorization.
- Google access tokens and refresh tokens are stored in KV / the session. Access control and secret
  management in your environment are your responsibility.

## Disclaimer

- This software is provided under the **MIT License**, **"AS IS" and without warranty of any kind**.
  The author is not liable for any damages arising from its use (see `LICENSE`).
- The health data this software provides, and any responses Claude bases on it, are
  **not medical advice, diagnosis, or treatment**. Always consult a healthcare professional for
  health-related decisions.
- The health data that is fetched and stored is your own sensitive information. **Handling that
  data, protecting your privacy, and complying with applicable laws are your responsibility.**

## Contributing

Issues and PRs are welcome — especially for verifying data type IDs, adding supported data types,
and strengthening security.

## License

[MIT License](./LICENSE) © 2026 yasuch
