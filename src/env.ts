import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  AUDIT_DB: D1Database;
  // marketing-signals' database (IG/FB history its cron writes). Read only by code: no D1 binding is read-only.
  SIGNALS_DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_ORIGIN: string;
  ALLOWED_EMAILS: string;
  ADS_MAX_DAILY_BUDGET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  GOOGLE_SA_JSON: string;
  CONFIRM_HMAC_KEY: string;
}

// What completeAuthorization() stores and every /mcp request receives as ctx.props.
export interface AuthProps {
  email: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
