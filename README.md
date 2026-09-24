# Health Advisor — an MCP server for the Google Health API

**English** | [日本語](./README_ja.md)

An MCP server that reads your own health data (via your Fitbit account) from the
**Google Health API** and exposes it to Claude (Desktop / Mobile / Web), plus a single
write tool for logging meals.
It deploys to **Cloudflare Workers** and **runs locally from the same code** with `wrangler dev`.

- Data source: **your Fitbit account** (Pixel Watch works too)
- Coverage: **general activity + sleep** (read-only), **meal logs** (read + write)
- API: `https://health.googleapis.com/v4` (successor to the Google Fit REST API, which shuts down at the end of 2026)

> ⚠️ **Health Connect is on-device only on Android (no cloud REST API)**, so it is not used here.
> This project uses the **Google Health API**, which can serve data from the cloud.

> 🚧 **Status: experimental**
> Endpoints and data type IDs have been checked against the official discovery document
> (revision 20260916), but end-to-end verification of every tool against real data is still
> in progress. This is intended for **self-hosted personal use**.

---

## MCP tools

Everything is read-only except `log_meal`, the one tool that writes to Google Health.

| Tool | Description |
| --- | --- |
| `list_available_data_types` | Lists the available data types and the methods each one supports |
| `get_daily_activity_summary` | Daily summary (steps / distance / calories / active minutes / floors) via `dailyRollUp` |
| `get_activity_datapoints` | Flexible access to any activity type (`list` / `reconcile` / `rollUp` / `dailyRollUp`) |
| `get_heart_rate` | Heart rate data (`list` / `rollUp`) |
| `get_sleep_logs` | Sleep logs, including sleep stages |
| `log_meal` | **Writes** a meal (`nutrition-log`) to Google Health, with calories and nutrients |
| `list_meal_logs` | Meal logs previously written through this server |

---

## Setup

### Quick start

```bash
./scripts/setup.sh    # = npm run setup (installs dependencies and creates .dev.vars)
```

Only step 2 below (the Google Cloud side) has to be done by hand in the Console.
Steps 1, 3 and 4 are handled by the scripts — read them only if you want to know what happens.

### 1. Install dependencies

```bash
npm install
```

> `./scripts/setup.sh` does this for you.

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
     - `.../auth/googlehealth.nutrition.writeonly` (meal logging)
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

> `./scripts/setup.sh` creates `.dev.vars` and generates `COOKIE_ENCRYPTION_KEY` for you
> (an existing `.dev.vars` is never overwritten). You only have to fill in the client ID and secret.

### 4. Create a KV namespace (for production deployments)

```bash
npx wrangler kv namespace create OAUTH_KV
# Paste the returned id into kv_namespaces[].id in wrangler.jsonc
```

> `./scripts/deploy.sh` looks up the namespace, creates it if missing and fills the id into a
> generated config, so you never have to paste it by hand (and `wrangler.jsonc` stays untouched).

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
npm run deploy:auto     # = ./scripts/deploy.sh
```

The script runs these steps in order, and is idempotent — running it again is always safe:

1. Check that you are logged in to Cloudflare
2. Verify that all three secrets are present in `.dev.vars`
3. Run `npm run typecheck`, so code that does not compile never gets deployed
4. Look up the KV namespace, creating it if it does not exist yet
5. Write the resolved id into a generated `wrangler.generated.jsonc` (`wrangler.jsonc` is left alone)
6. Upload the Worker together with its secrets via `wrangler deploy --secrets-file`
7. Print the deployed URL and the manual steps that are still left

To validate everything without uploading:

```bash
npm run deploy:check    # = ./scripts/deploy.sh --dry-run
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SECRETS_FILE` | `.dev.vars` | File to read secrets from (`.env` format). Use e.g. `.env.production` for separate production values |
| `OAUTH_KV_ID` | (auto-resolved) | Pin the KV namespace id explicitly |
| `KV_TITLE` | `health-advisor-OAUTH_KV` | Name of the KV namespace to look up or create |
| `SKIP_TYPECHECK` | — | Set to `1` to skip the type check |

<details>
<summary>Deploying manually</summary>

```bash
# After replacing kv_namespaces[].id in wrangler.jsonc with the real id
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY

npm run deploy
```

</details>

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

To check meal logging, ask something like:

> Log a salmon rice ball for lunch today, 180 kcal, and then show me what I logged today.

`log_meal` writes the entry and `list_meal_logs` reads it back.

> ℹ️ If you were already authorized before meal logging was added, your existing token does not
> carry the `nutrition.writeonly` scope and `log_meal` will fail with a permission error.
> Reconnect the server in Claude (and add the new scope to your OAuth consent screen) to re-consent.

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
  | `create` | POST | `.../dataPoints` | body `DataPoint` (used by `log_meal`) |

  `list` is a plain GET on the collection, not a colon-suffixed sub-method
  (there is no `dataPoints:list` route — it returns 404).
- **Field names in filter expressions**: URL paths use kebab-case (`heart-rate`), while AIP-160
  filter expressions use snake_case (`heart_rate.sample_time.physical_time`). Types with a duration
  use `{type}.interval.start_time`; instantaneous types use `{type}.sample_time.physical_time`.
  **Sleep is the exception**: it cannot be filtered by start time, so `sleep.interval.end_time` is used.
  **Session types other than sleep and ECG** (such as `nutrition-log`) can only be filtered by
  `{type}.interval.civil_start_time`, which is a *civil* (timezone-less) date — physical timestamps
  are not accepted there, so `list_meal_logs` takes local calendar dates.
- **Page size**: `sleep` and `exercise` are capped at 25 items; other data types allow up to 10000.
- **Rate limits**: they are not publicly documented, so the client implements retries with
  exponential backoff. Keep tool calls infrequent at first. **Writes are never retried
  automatically**, since a re-sent create could double-log a meal that actually succeeded.
  Pass `dataPointId` to `log_meal` to make a retry idempotent.
- **Meal logging caveats**:
  - The API takes a nutrition log either as an *identified food* (a reference to a `Food`
    resource, via `food`) or as an *anonymous food* (`foodName` plus nutrients you supply).
    v4 exposes no method to search or create `Food` resources, so `log_meal` normally writes
    anonymous foods.
  - **Anonymous food logs cannot be edited afterwards** (that is an API restriction, not a
    limitation of this server), so a correction means logging the meal again.
  - `log_meal` requires a timezone on `eatenAt`, because the API's session interval requires an
    explicit UTC offset and it cannot be guessed server-side.
  - Protein has no dedicated field in the API; it is sent as `nutrients[PROTEIN]`.
  - There is **no `googlehealth.nutrition.readonly` scope**. Reads of `nutrition-log` are
    authorized by `nutrition.writeonly`, which covers the data this app itself wrote — so
    `list_meal_logs` shows meals logged through this server, not meals logged in other apps.
- **Fitbit → Google linkage**: your Fitbit account may need to be linked to Google before its data
  shows up in the Google Health API.

## Project layout

```
src/
  index.ts          OAuthProvider wiring
  google-handler.ts Google OAuth (authorize / callback)
  mcp.ts            McpAgent and the tool definitions
  google-health.ts  Google Health API client
  nutrition.ts      meal log (nutrition-log) payload builder
  types.ts          shared types
scripts/
  setup.sh          first-time setup (dependencies + .dev.vars)
  deploy.sh         deploy automation (KV lookup, type check, secrets, deploy)
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
