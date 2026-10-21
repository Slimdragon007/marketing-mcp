import { describe, expect, it } from "vitest";
import { CONFIRM_TTL_MS, ConfirmError, canonicalJson, consumeConfirmToken, issueConfirmToken } from "../src/safety/confirm";
import { FakeD1, HMAC_KEY, asD1 } from "./helpers";

const t0 = new Date("2026-10-07T12:00:00.000Z");
const base = { email: "owner@example.com", tool: "gsc_sitemap_submit", payload: { site: "a", sitemap_url: "b" } };

async function setup() {
  const fake = new FakeD1();
  const db = asD1(fake);
  const { confirm_token } = await issueConfirmToken(db, HMAC_KEY, { ...base, before: { exists: false } }, t0);
  return { fake, db, token: confirm_token };
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConfirmError) return e.reason;
    throw e;
  }
  return "accepted";
};

describe("confirm_token", () => {
  it("accepts the exact payload once", async () => {
    const { db, token } = await setup();
    const c = await consumeConfirmToken(db, HMAC_KEY, { ...base, token }, t0);
    expect(c.before).toEqual({ exists: false });
  });

  it("treats key order as the same payload", async () => {
    const { db, token } = await setup();
    const payload = { sitemap_url: "b", site: "a" };
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, payload, token }, t0))).toBe("accepted");
  });

  it("rejects a changed payload without spending the token", async () => {
    const { db, token } = await setup();
    const changed = { ...base, payload: { site: "a", sitemap_url: "c" }, token };
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, changed, t0))).toBe("mismatch");
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token }, t0))).toBe("accepted");
  });

  it("rejects another user or another tool", async () => {
    const { db, token } = await setup();
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, email: "admin@example.com", token }, t0))).toBe("mismatch");
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, tool: "gsc_sitemap_delete", token }, t0))).toBe("mismatch");
  });

  it("rejects reuse", async () => {
    const { db, token } = await setup();
    await consumeConfirmToken(db, HMAC_KEY, { ...base, token }, t0);
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token }, t0))).toBe("reused");
  });

  it("rejects expiry at exactly the TTL", async () => {
    const { db, token } = await setup();
    const late = new Date(t0.getTime() + CONFIRM_TTL_MS);
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token }, late))).toBe("expired");
    const justBefore = new Date(t0.getTime() + CONFIRM_TTL_MS - 1);
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token }, justBefore))).toBe("accepted");
  });

  it("rejects a forged signature, a tampered row, an unknown id, and junk", async () => {
    const { fake, db, token } = await setup();
    const [id] = token.split(".");
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token: `${id}.${"0".repeat(64)}` }, t0))).toBe("bad_signature");
    expect(await reason(consumeConfirmToken(db, "another-key-0123456789abcdef0123456789", { ...base, token }, t0))).toBe(
      "bad_signature",
    );
    fake.sqlite.prepare("UPDATE pending_writes SET expires_at = '2099-01-01T00:00:00.000Z'").run();
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token }, t0))).toBe("bad_signature");
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token: `${crypto.randomUUID()}.${"a".repeat(64)}` }, t0))).toBe(
      "unknown",
    );
    expect(await reason(consumeConfirmToken(db, HMAC_KEY, { ...base, token: "nope" }, t0))).toBe("malformed");
  });

  it("refuses to run without a real HMAC key", async () => {
    const db = asD1(new FakeD1());
    await expect(issueConfirmToken(db, "", { ...base, before: null }, t0)).rejects.toThrow(/CONFIRM_HMAC_KEY/);
  });

  it("canonicalJson sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}]},"b":1}');
  });
});
