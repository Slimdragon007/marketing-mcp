# marketing-mcp

A remote MCP server on Cloudflare Workers that lets Claude (web, desktop, and phone) read marketing data and make a small set of guarded changes in Google Analytics 4 and Google Search Console. It also reads stored Instagram and Facebook Page history.

I built it for my photography business, where it runs in production and replaced a paid reporting tool (Supermetrics). This public copy uses placeholder IDs and example domains; the code and tests are the same.

## How it works

```
Claude custom connector
  -> /mcp (streamable HTTP, stateless) + OAuth 2.1 (@cloudflare/workers-oauth-provider, KV OAUTH_KV)
  -> /authorize: consent page -> Google sign-in -> email allowlist check -> grant {email}
  -> tools call Google with a service account (read and write tokens use different scopes)
  -> every executed write is logged to D1 (AUDIT_DB)
```

Two kinds of auth, on purpose:
- **OAuth answers "who is the user?"** Claude signs in through OAuth 2.1 with a consent page, then Google sign-in. Only allowlisted, verified emails get a grant, and the allowlist is checked again on every `/mcp` request.
- **A service account is how the server calls Google.** Read calls and write calls get separately scoped tokens.

## Write safety

Changing analytics settings is hard to undo, so every write follows the same contract:

1. Every write tool defaults to `dry_run: true` and returns the proposed change, the current value, and a `confirm_token`.
2. To execute, call again with the same arguments, `dry_run: false`, and the token.
3. The token is HMAC-signed over the user, the tool, the exact payload, a hash of the previewed state, and a 10-minute expiry. It is stored in D1 and consumed by one conditional `UPDATE`, so it works once.
4. Confirmations are serialized per Google setting with a short D1 lease. Every Google call has a 15-second deadline, and the lease is re-checked right before the write.
5. At confirm the server re-reads the setting. If it changed since the dry run, nothing executes (`rejected_drift`).
6. An audit row is written as `pending` before Google is called, then finalized as `success`, `error` (Google refused, nothing changed), or `indeterminate` (timeout or 5xx: check with a read tool before any retry).
7. Writes are never retried automatically, to avoid double writes.
8. There are no tools for deleting properties or streams, user permissions, billing, or account cancellation.

Limit: the lock covers writes made through this server. GA4 Admin and Search Console have no conditional writes, so an edit made in Google's own UI between the re-read and the write is not detected.

## Tools

- **Read:** `ga4_report`, `ga4_realtime`, `ga4_admin_get` (key events, custom dimensions, Google Ads links, data streams), `gsc_query`, `gsc_sitemaps_list`, `list_changes` (the audit log)
- **Meta reads:** `ig_insights`, `fb_page_insights`, from a D1 database that a separate Worker fills daily. This server only reads it, and a test enforces that.
- **Write (dry run + confirm token):** `ga4_key_event_upsert`, `ga4_custom_dimension_create`, `gsc_sitemap_submit`, `gsc_sitemap_delete`

## Secrets

Never in the repo. In production they live in 1Password and are loaded into the Worker with `scripts/set-secrets.sh`, which prints names and lengths only.

| Worker secret | What |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth web client for the Claude sign-in |
| `GOOGLE_SA_JSON` | Service account key with GA4 Editor and Search Console access |
| `CONFIRM_HMAC_KEY` | Signs confirm tokens (32+ characters) |

## Run it

Requires Node 22+.

```bash
npm ci
npm test            # vitest: real migration SQL on node:sqlite, mocked Google APIs
npm run typecheck
npm run lint
npm run dry-run     # wrangler bundle check, no deploy
```

Local dev:

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply marketing-mcp-audit --local
npx wrangler dev --port 8799
```

To deploy your own: create the KV namespace and D1 databases, put their IDs and your allowlisted email in `wrangler.jsonc`, set the four secrets, run `npm run deploy`, then add `https://<your-worker>/mcp` as a custom connector in Claude.

## Stack

TypeScript, Cloudflare Workers, KV, D1, `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/server`, zod, Vitest. Google Analytics Data and Admin APIs, Search Console API.
