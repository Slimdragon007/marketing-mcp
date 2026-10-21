import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GoogleClient } from "../src/google/client";
import { listChanges } from "../src/safety/audit";
import { InputError } from "../src/targets";
import { guarded, type ToolContext } from "../src/tools/common";
import { keyEventSpec, runWrite, sitemapSubmitSpec } from "../src/tools/write";
import { FakeD1, HMAC_KEY, asD1, fakeGoogle, fakeServiceAccountJson } from "./helpers";

let saJson: string;
beforeAll(async () => {
  saJson = await fakeServiceAccountJson();
});

const SITEMAP = "https://shop.example.com/sitemap.xml";
const SM_URL = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent("https://shop.example.com/")}/sitemaps/${encodeURIComponent(SITEMAP)}`;

function sitemapWorld(opts: { putStatus?: number; putThrows?: boolean; readbackStatus?: number } = {}) {
  const state = { exists: false };
  const g = fakeGoogle({
    [`GET ${SM_URL}`]: () => {
      if (state.exists && opts.readbackStatus) return Response.json({ error: { code: opts.readbackStatus } }, { status: opts.readbackStatus });
      return state.exists ? Response.json({ path: SITEMAP, lastDownloaded: new Date().toISOString() }) : new Response("", { status: 404 });
    },
    [`PUT ${SM_URL}`]: () => {
      if (opts.putThrows) throw new TypeError("network connection lost");
      if (opts.putStatus) return Response.json({ error: { code: opts.putStatus, message: "denied", status: "PERMISSION_DENIED" } }, { status: opts.putStatus });
      state.exists = true;
      return new Response("", { status: 200 });
    },
  });
  return { state, ...g };
}

function context(fetchImpl: ReturnType<typeof fakeGoogle>["fetchImpl"], fake = new FakeD1()) {
  const ctx: ToolContext = {
    db: asD1(fake),
    google: () => new GoogleClient(saJson, fetchImpl),
    email: "owner@example.com",
    hmacKey: HMAC_KEY,
    now: () => new Date(),
  };
  return { ctx, fake };
}

const args = { site: "shop", sitemap_url: SITEMAP };
const puts = (calls: { method: string }[]) => calls.filter((c) => c.method === "PUT").length;

describe("write flow", () => {
  it("dry run previews without calling the write endpoint", async () => {
    const w = sitemapWorld();
    const { ctx, fake } = context(w.fetchImpl);
    const r = (await runWrite(sitemapSubmitSpec, { ...args, dry_run: true }, ctx)) as Record<string, any>;
    expect(r.dry_run).toBe(true);
    expect(r.current).toEqual({ exists: false, path: SITEMAP });
    expect(r.confirm_token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
    expect(puts(w.calls)).toBe(0);
    expect(fake.rows("SELECT * FROM audit_log")).toHaveLength(0);
  });

  it("confirm executes once and logs before/after; replay is refused", async () => {
    const w = sitemapWorld();
    const { ctx } = context(w.fetchImpl);
    const dry = (await runWrite(sitemapSubmitSpec, args, ctx)) as Record<string, any>;
    const done = (await runWrite(sitemapSubmitSpec, { ...args, dry_run: false, confirm_token: dry.confirm_token }, ctx)) as Record<string, any>;
    expect(done.executed).toBe(true);
    expect(puts(w.calls)).toBe(1);
    const [log] = await listChanges(ctx.db, { limit: 5 });
    expect(log).toMatchObject({ tool: "gsc_sitemap_submit", result: "success", before: { exists: false } });
    expect(log.after).toMatchObject({ path: SITEMAP });
    expect(log.credential).toContain("mcp-test@example.iam.gserviceaccount.com");
    await expect(runWrite(sitemapSubmitSpec, { ...args, dry_run: false, confirm_token: dry.confirm_token }, ctx)).rejects.toMatchObject({ reason: "reused" });
    expect(puts(w.calls)).toBe(1);
  });

  it("the shop alias and the raw site URL are the same payload", async () => {
    const w = sitemapWorld();
    const { ctx } = context(w.fetchImpl);
    const dry = (await runWrite(sitemapSubmitSpec, args, ctx)) as Record<string, any>;
    const raw = { site: "https://shop.example.com/", sitemap_url: SITEMAP, dry_run: false, confirm_token: dry.confirm_token };
    expect(((await runWrite(sitemapSubmitSpec, raw, ctx)) as Record<string, any>).executed).toBe(true);
  });

  it("refuses when the setting changed after the dry run", async () => {
    const w = sitemapWorld();
    const { ctx } = context(w.fetchImpl);
    const dry = (await runWrite(sitemapSubmitSpec, args, ctx)) as Record<string, any>;
    w.state.exists = true;
    const r = await guarded(() => runWrite(sitemapSubmitSpec, { ...args, dry_run: false, confirm_token: dry.confirm_token }, ctx));
    expect(r.isError).toBe(true);
    expect(puts(w.calls)).toBe(0);
    const [log] = await listChanges(ctx.db, { limit: 5 });
    expect(log.result).toBe("rejected_drift");
  });

  it("returns Google's error verbatim, logs it, and does not retry", async () => {
    const w = sitemapWorld({ putStatus: 403 });
    const { ctx } = context(w.fetchImpl);
    const dry = (await runWrite(sitemapSubmitSpec, args, ctx)) as Record<string, any>;
    const r = await guarded(() => runWrite(sitemapSubmitSpec, { ...args, dry_run: false, confirm_token: dry.confirm_token }, ctx));
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatchObject({ http_status: 403, google_error: { status: "PERMISSION_DENIED" } });
    expect(body.error.credential).toContain("write scopes");
    expect(puts(w.calls)).toBe(1);
    const [log] = await listChanges(ctx.db, { limit: 5 });
    expect(log.result).toBe("error");
  });

  it("a confirm_token on a preview call is refused and stays usable", async () => {
    const w = sitemapWorld();
    const { ctx } = context(w.fetchImpl);
    const dry = (await runWrite(sitemapSubmitSpec, args, ctx)) as Record<string, any>;
    for (const preview of [{ ...args, confirm_token: dry.confirm_token }, { ...args, dry_run: true, confirm_token: dry.confirm_token }]) {
      await expect(runWrite(sitemapSubmitSpec, preview, ctx)).rejects.toBeInstanceOf(InputError);
    }
    expect(puts(w.calls)).toBe(0);
    const done = (await runWrite(sitemapSubmitSpec, { ...args, dry_run: false, confirm_token: dry.confirm_token }, ctx)) as Record<string, any>;
    expect(done.executed).toBe(true);
  });

  it("a failed readback after a successful write still reports executed and logs success", async () => {
    const w = sitemapWorld({ readbackStatus: 503 });
    const { ctx } = context(w.fetchImpl);
    const dry = (await runWrite(sitemapSubmitSpec, args, ctx)) as Record<string, any>;
    const done = (await runWrite(sitemapSubmitSpec, { ...args, dry_run: false, confirm_token: dry.confirm_token }, ctx)) as Record<string, any>;
    expect(done.executed).toBe(true);
    expect(done.readback_error).toMatchObject({ http_status: 503 });
    const [log] = await listChanges(ctx.db, { limit: 5 });
    expect(log.result).toBe("success");
    expect(log.error).toContain("readback failed");
  });

  it("a network failure during the write is reported as unknown, not as not-executed", async () => {
    const w = sitemapWorld({ putThrows: true });
    const { ctx } = context(w.fetchImpl);
    const dry = (await runWrite(sitemapSubmitSpec, args, ctx)) as Record<string, any>;
    const r = await guarded(() => runWrite(sitemapSubmitSpec, { ...args, dry_run: false, confirm_token: dry.confirm_token }, ctx));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).executed).toBe("unknown");
    const [log] = await listChanges(ctx.db, { limit: 5 });
    expect(log.result).toBe("indeterminate");
  });

  it("dry_run:false without a token is refused", async () => {
    const w = sitemapWorld();
    const { ctx } = context(w.fetchImpl);
    await expect(runWrite(sitemapSubmitSpec, { ...args, dry_run: false }, ctx)).rejects.toBeInstanceOf(InputError);
  });

  it("rejects a sitemap on another host before calling Google", async () => {
    const w = sitemapWorld();
    const { ctx } = context(w.fetchImpl);
    await expect(runWrite(sitemapSubmitSpec, { site: "shop", sitemap_url: "https://evil.example/sitemap.xml" }, ctx)).rejects.toBeInstanceOf(
      InputError,
    );
    expect(w.calls).toHaveLength(0);
  });
});

describe("lease checks around slow D1 replies", () => {
  const LIST = "https://analyticsadmin.googleapis.com/v1beta/properties/100000002/keyEvents";
  const NAME = "properties/100000002/keyEvents/1";

  function world() {
    const w = { ev: { name: NAME, eventName: "purchase", countingMethod: "ONCE_PER_EVENT" } as Record<string, string> | null };
    const g = fakeGoogle({
      [`GET ${LIST}`]: () => Response.json({ keyEvents: w.ev ? [w.ev] : [] }),
      [`PATCH https://analyticsadmin.googleapis.com/v1beta/${NAME}`]: (c) => {
        w.ev = { ...w.ev!, ...JSON.parse(c.body!) };
        return Response.json(w.ev);
      },
      [`DELETE https://analyticsadmin.googleapis.com/v1beta/${NAME}`]: () => {
        w.ev = null;
        return Response.json({});
      },
    });
    return { w, g };
  }

  // Stalls the first statement matching `match`, lets another confirmation run 61 s later, then resumes.
  for (const [label, match] of [
    ["the pending audit insert", /^\s*INSERT INTO audit_log/],
    ["the lease renewal", /^\s*UPDATE write_locks/],
  ] as const) {
    it(`a stale confirmation never writes when ${label} replies after the lease expired`, async () => {
      const { w, g } = world();
      const fake = new FakeD1();
      const { ctx } = context(g.fetchImpl, fake);
      let clock = new Date("2026-10-07T12:00:00.000Z");
      ctx.now = () => clock;
      const unmark = { property: "shop", event_name: "purchase", action: "unmark" as const };
      const patch = { property: "shop", event_name: "purchase", action: "mark" as const, counting_method: "ONCE_PER_SESSION" as const };
      const t1 = ((await runWrite(keyEventSpec, unmark, ctx)) as Record<string, any>).confirm_token;
      const t2 = ((await runWrite(keyEventSpec, patch, ctx)) as Record<string, any>).confirm_token;

      let reached!: () => void;
      const atStall = new Promise<void>((r) => (reached = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let armed = true;
      fake.afterStatement = async (sql) => {
        if (armed && match.test(sql)) {
          armed = false;
          reached();
          await gate;
        }
      };
      const stalled = guarded(() => runWrite(keyEventSpec, { ...unmark, dry_run: false, confirm_token: t1 }, ctx));
      await atStall;

      clock = new Date(clock.getTime() + 61_000);
      const second = await guarded(() => runWrite(keyEventSpec, { ...patch, dry_run: false, confirm_token: t2 }, ctx));
      expect(second.isError).toBeFalsy();

      release();
      const first = await stalled;
      expect(first.isError).toBe(true);
      expect(JSON.parse(first.content[0].text).executed).toBe(false);
      expect(g.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
      expect(w.ev).toMatchObject({ countingMethod: "ONCE_PER_SESSION" });
    });
  }
});

describe("ga4_key_event_upsert", () => {
  it("a confirmation that stalls past the lock lease never writes on its stale snapshot", async () => {
    const LIST = "https://analyticsadmin.googleapis.com/v1beta/properties/100000002/keyEvents";
    const NAME = "properties/100000002/keyEvents/1";
    let ev: Record<string, string> | null = { name: NAME, eventName: "purchase", countingMethod: "ONCE_PER_EVENT" };
    let pause: { reached: () => void; release: Promise<void> } | null = null;
    const g = fakeGoogle({
      [`GET ${LIST}`]: async () => {
        const snapshot = ev;
        if (pause) {
          const p = pause;
          pause = null;
          p.reached();
          await p.release;
        }
        return Response.json({ keyEvents: snapshot ? [snapshot] : [] });
      },
      [`PATCH https://analyticsadmin.googleapis.com/v1beta/${NAME}`]: (c) => {
        ev = { ...ev!, ...JSON.parse(c.body!) };
        return Response.json(ev);
      },
      [`DELETE https://analyticsadmin.googleapis.com/v1beta/${NAME}`]: () => {
        ev = null;
        return Response.json({});
      },
    });
    let clock = new Date("2026-10-07T12:00:00.000Z");
    const { ctx } = context(g.fetchImpl);
    ctx.now = () => clock;
    const unmark = { property: "shop", event_name: "purchase", action: "unmark" as const };
    const patch = { property: "shop", event_name: "purchase", action: "mark" as const, counting_method: "ONCE_PER_SESSION" as const };
    const t1 = ((await runWrite(keyEventSpec, unmark, ctx)) as Record<string, any>).confirm_token;
    const t2 = ((await runWrite(keyEventSpec, patch, ctx)) as Record<string, any>).confirm_token;

    let reached!: () => void;
    const atRead = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    pause = { reached, release: new Promise<void>((r) => (release = r)) };
    const stalled = guarded(() => runWrite(keyEventSpec, { ...unmark, dry_run: false, confirm_token: t1 }, ctx));
    await atRead;

    clock = new Date(clock.getTime() + 61_000);
    const second = await guarded(() => runWrite(keyEventSpec, { ...patch, dry_run: false, confirm_token: t2 }, ctx));
    expect(second.isError).toBeFalsy();

    release();
    const first = await stalled;
    expect(first.isError).toBe(true);
    expect(JSON.parse(first.content[0].text).executed).toBe(false);
    expect(g.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(ev).toMatchObject({ countingMethod: "ONCE_PER_SESSION" });
  });

  it("two conflicting confirmations at once: only one executes", async () => {
    const LIST = "https://analyticsadmin.googleapis.com/v1beta/properties/100000002/keyEvents";
    const NAME = "properties/100000002/keyEvents/1";
    let ev: Record<string, string> | null = { name: NAME, eventName: "purchase", countingMethod: "ONCE_PER_EVENT" };
    const slow = () => new Promise((r) => setTimeout(r, 20));
    const g = fakeGoogle({
      [`GET ${LIST}`]: async () => {
        await slow();
        return Response.json({ keyEvents: ev ? [ev] : [] });
      },
      [`PATCH https://analyticsadmin.googleapis.com/v1beta/${NAME}`]: async (c) => {
        await slow();
        ev = { ...ev!, ...JSON.parse(c.body!) };
        return Response.json(ev);
      },
      [`DELETE https://analyticsadmin.googleapis.com/v1beta/${NAME}`]: async () => {
        await slow();
        ev = null;
        return Response.json({});
      },
    });
    const { ctx } = context(g.fetchImpl);
    const patch = { property: "shop", event_name: "purchase", action: "mark" as const, counting_method: "ONCE_PER_SESSION" as const };
    const unmark = { property: "shop", event_name: "purchase", action: "unmark" as const };
    const t1 = ((await runWrite(keyEventSpec, patch, ctx)) as Record<string, any>).confirm_token;
    const t2 = ((await runWrite(keyEventSpec, unmark, ctx)) as Record<string, any>).confirm_token;
    const results = await Promise.all([
      guarded(() => runWrite(keyEventSpec, { ...patch, dry_run: false, confirm_token: t1 }, ctx)),
      guarded(() => runWrite(keyEventSpec, { ...unmark, dry_run: false, confirm_token: t2 }, ctx)),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === "PATCH" || c.method === "DELETE")).toHaveLength(1);
  });

  const LIST = "https://analyticsadmin.googleapis.com/v1beta/properties/100000002/keyEvents";

  it("reports no change when already marked the same way, and issues no token", async () => {
    const g = fakeGoogle({
      [`GET ${LIST}`]: () =>
        Response.json({ keyEvents: [{ name: "properties/100000002/keyEvents/1", eventName: "purchase", countingMethod: "ONCE_PER_EVENT" }] }),
    });
    const { ctx, fake } = context(g.fetchImpl);
    const r = (await runWrite(keyEventSpec, { property: "shop", event_name: "purchase", action: "mark" }, ctx)) as Record<string, any>;
    expect(r.no_change).toBe(true);
    expect(fake.rows("SELECT * FROM pending_writes")).toHaveLength(0);
  });

  it("creates a key event after confirm", async () => {
    const g = fakeGoogle({
      [`GET ${LIST}`]: () => Response.json({}),
      [`POST ${LIST}`]: (c) => Response.json({ name: "properties/100000002/keyEvents/9", ...JSON.parse(c.body!) }),
    });
    const { ctx } = context(g.fetchImpl);
    const a = { property: "shop", event_name: "begin_checkout", action: "mark" as const };
    const dry = (await runWrite(keyEventSpec, a, ctx)) as Record<string, any>;
    expect(dry.change).toContain("begin_checkout");
    const done = (await runWrite(keyEventSpec, { ...a, dry_run: false, confirm_token: dry.confirm_token }, ctx)) as Record<string, any>;
    expect(done.after).toMatchObject({ eventName: "begin_checkout", countingMethod: "ONCE_PER_EVENT" });
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("GoogleClient default fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Workers rejects fetch called with any receiver other than the global; this fake does the same.
  it("calls the global fetch without binding it to the client", async () => {
    const { fetchImpl } = fakeGoogle({ "GET https://example.test/": () => Response.json({ ok: true }) });
    vi.stubGlobal("fetch", function (this: unknown, input: string, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return fetchImpl(input, init);
    });
    const g = new GoogleClient(saJson);
    await expect(g.call("read", "GET", "https://example.test/")).resolves.toEqual({ ok: true });
  });
});
