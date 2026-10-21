import { describe, expect, it } from "vitest";
import { checkGoogleClaims, decodeJwtPayload, isAllowed } from "../src/auth/allowlist";

const ALLOW = "owner@example.com, admin@example.com";
const ok = { iss: "https://accounts.google.com", aud: "cid", exp: 2000, email: "Admin@Example.com", email_verified: true };
const opts = { clientId: "cid", allowlist: ALLOW, nowSec: 1000 };

describe("allowlist", () => {
  it("accepts listed emails case-insensitively", () => {
    expect(isAllowed("Owner@Example.com", ALLOW)).toBe(true);
    expect(checkGoogleClaims(ok, opts)).toEqual({ ok: true, email: "admin@example.com" });
  });

  it("rejects other emails, empty lists, and missing emails", () => {
    expect(isAllowed("someone@gmail.com", ALLOW)).toBe(false);
    expect(isAllowed("admin@example.com", "")).toBe(false);
    expect(isAllowed(undefined, ALLOW)).toBe(false);
    expect(checkGoogleClaims({ ...ok, email: "someone@gmail.com" }, opts).ok).toBe(false);
  });

  it("rejects unverified, wrong issuer, wrong audience, and expired tokens", () => {
    expect(checkGoogleClaims({ ...ok, email_verified: false }, opts).ok).toBe(false);
    expect(checkGoogleClaims({ ...ok, iss: "https://evil.example" }, opts).ok).toBe(false);
    expect(checkGoogleClaims({ ...ok, aud: "other" }, opts).ok).toBe(false);
    expect(checkGoogleClaims({ ...ok, exp: 1000 }, opts).ok).toBe(false);
  });

  it("decodes a JWT payload", () => {
    const part = Buffer.from(JSON.stringify(ok)).toString("base64url");
    expect(decodeJwtPayload(`x.${part}.y`).email).toBe("Admin@Example.com");
  });
});
