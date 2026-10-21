export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowed(email: string | undefined, raw: string | undefined): boolean {
  return !!email && parseAllowlist(raw).has(email.trim().toLowerCase());
}

export interface GoogleIdClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  email?: string;
  email_verified?: boolean | string;
}

// The id_token comes straight from Google's token endpoint over TLS, so per
// OpenID Connect Core 3.1.3.7 the claims are checked without re-verifying the signature.
export function checkGoogleClaims(
  claims: GoogleIdClaims,
  opts: { clientId: string; allowlist: string | undefined; nowSec: number },
): { ok: true; email: string } | { ok: false; reason: string } {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    return { ok: false, reason: "id_token issuer is not Google" };
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) return { ok: false, reason: "id_token audience is not this app" };
  if (typeof claims.exp !== "number" || claims.exp <= opts.nowSec) return { ok: false, reason: "id_token expired" };
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    return { ok: false, reason: "Google account email is not verified" };
  }
  if (!isAllowed(claims.email, opts.allowlist)) return { ok: false, reason: "this Google account is not allowed" };
  return { ok: true, email: claims.email!.trim().toLowerCase() };
}

export function decodeJwtPayload(jwt: string): GoogleIdClaims {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("id_token is not a JWT");
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as GoogleIdClaims;
}
