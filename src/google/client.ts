import type { FetchLike } from "../env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Bounds every Google call, so a write always finishes well inside the 60 s lock lease.
export const GOOGLE_TIMEOUT_MS = 15_000;

// Reads and writes use separate tokens so a read can never carry write scope.
export const SCOPES = {
  read: [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
  ],
  write: ["https://www.googleapis.com/auth/analytics.edit", "https://www.googleapis.com/auth/webmasters"],
} as const;
export type Access = keyof typeof SCOPES;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// Google's error body passed through unchanged, plus which credential made the call.
export class GoogleApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly google: unknown,
    readonly credential: string,
  ) {
    super(`Google API HTTP ${httpStatus}`);
  }
  toJSON() {
    return { http_status: this.httpStatus, google_error: this.google, credential: this.credential };
  }
}

export class ConfigError extends Error {}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const bin = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let sa: Partial<ServiceAccount>;
  try {
    sa = JSON.parse(json) as Partial<ServiceAccount>;
  } catch {
    throw new ConfigError("GOOGLE_SA_JSON is not valid JSON");
  }
  if (!sa.client_email || !sa.private_key) throw new ConfigError("GOOGLE_SA_JSON is missing client_email or private_key");
  return { client_email: sa.client_email, private_key: sa.private_key };
}

async function signJwt(sa: ServiceAccount, scope: string, nowSec: number): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(
    enc.encode(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 })),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

// One instance per MCP request; tokens are cached only for that request.
export class GoogleClient {
  private readonly sa: ServiceAccount;
  private readonly tokens = new Map<Access, string>();

  constructor(
    saJson: string,
    // Wrapped: Workers throws "Illegal invocation" when fetch is called as this.fetchImpl(...).
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = GOOGLE_TIMEOUT_MS,
  ) {
    this.sa = parseServiceAccount(saJson);
  }

  credential(access: Access): string {
    return `service account ${this.sa.client_email} (${access} scopes)`;
  }

  private async token(access: Access): Promise<string> {
    const cached = this.tokens.get(access);
    if (cached) return cached;
    const jwt = await signJwt(this.sa, SCOPES[access].join(" "), Math.floor(Date.now() / 1000));
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !body.access_token) throw new GoogleApiError(res.status, body, this.credential(access));
    this.tokens.set(access, body.access_token);
    return body.access_token;
  }

  // Returns parsed JSON, or null for a 404 when allow404 is set (used to read "before" state).
  async call<T>(
    access: Access,
    method: string,
    url: string,
    body?: unknown,
    opts: { allow404?: boolean } = {},
  ): Promise<T | null> {
    const token = await this.token(access);
    const res = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 2000) };
      }
    }
    if (!res.ok) throw new GoogleApiError(res.status, (parsed as { error?: unknown }).error ?? parsed, this.credential(access));
    return parsed as T;
  }
}
