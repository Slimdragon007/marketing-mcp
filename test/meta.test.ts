import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { mcpApiHandler } from "../src/mcp-handler";
import { fbPageInsights, igInsights, resolveRange } from "../src/signals/meta";
import { InputError } from "../src/targets";
import { FakeD1, HMAC_KEY, asD1, signalsD1 } from "./helpers";

const NOW = new Date("2026-09-25T10:00:00Z");

let db: FakeD1;
const D1 = () => asD1(db);

// Rows as the signals cron writes them: run 1 synced 2026-09-22..24 for every source.
function seed() {
  const run = (source: string, id: number) =>
    db.sqlite
      .prepare(
        `INSERT INTO sync_runs (id, source, trigger, started_at, finished_at, status, window_start, window_end, rows_written)
         VALUES (?, ?, 'cron', '2026-09-25T10:00:00Z', '2026-09-25T10:00:05Z', 'success', '2026-09-22', '2026-09-24', 1)`,
      )
      .run(id, source);
  run("ig", 1);
  run("fb", 2);
  const m = db.sqlite.prepare(
    "INSERT INTO meta_daily (date, platform, metric, value, run_id, synced_at) VALUES (?, ?, ?, ?, ?, '2026-09-25T10:00:05Z')",
  );
  for (const [date, reach] of [["2026-09-22", 40], ["2026-09-23", 45], ["2026-09-24", 50]] as const) {
    m.run(date, "ig", "reach", reach, 1);
    m.run(date, "ig", "views", 2, 1);
    m.run(date, "ig", "profile_views", 1, 1);
    m.run(date, "ig", "follower_count", 3, 1);
  }
  m.run("2026-09-24", "ig", "followers_count", 368, 1);
  m.run("2026-09-25", "ig", "followers_count", 369, 1);
  m.run("2026-09-25", "fb", "followers_count", 141, 2);
  const p = db.sqlite.prepare(
    `INSERT INTO ig_posts (media_id, posted_at, media_product_type, permalink, caption, reach, views, likes, run_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 583, 4, 1, '2026-09-25T10:00:05Z')`,
  );
  p.run("m1", "2026-09-20T18:00:00+0000", "FEED", "https://instagram.com/p/1", "Golden hour", 253);
  p.run("m2", "2026-09-10T18:00:00+0000", "REELS", "https://instagram.com/p/2", null, 90);
  p.run("m_old", "2025-01-01T00:00:00+0000", "FEED", null, null, 999);
}

beforeEach(() => {
  db = signalsD1();
  seed();
  db.prepared.length = 0;
});

describe("Meta reads from the signals D1", () => {
  it("defaults to the last 28 complete days and validates dates", () => {
    expect(resolveRange(undefined, undefined, NOW)).toEqual({ start: "2026-08-28", end: "2026-09-24" });
    expect(() => resolveRange("2026-09-30", "2026-09-01")).toThrow(InputError);
    expect(() => resolveRange("yesterday")).toThrow(InputError);
    expect(() => resolveRange("2020-01-01", "2026-01-01")).toThrow(/limited/);
  });

  it("days gives a relative window and cannot be mixed with start_date", () => {
    expect(resolveRange(undefined, undefined, NOW, 90)).toEqual({ start: "2026-06-27", end: "2026-09-24" });
    expect(resolveRange(undefined, "2026-09-24", NOW, 1)).toEqual({ start: "2026-09-24", end: "2026-09-24" });
    expect(() => resolveRange("2026-09-01", undefined, NOW, 7)).toThrow(/not both/);
    expect(() => resolveRange(undefined, undefined, NOW, 0)).toThrow(InputError);
  });

  it("ig_insights pivots daily metrics, sums totals without snapshots and ranks posts", async () => {
    const r = (await igInsights(D1(), { start_date: "2026-09-01", end_date: "2026-09-25", include_posts: true }, NOW)) as Record<string, any>;
    expect(r.daily["2026-09-22"]).toEqual({ reach: 40, views: 2, profile_views: 1, follower_count: 3 });
    expect(r.totals).toEqual({ reach: 135, views: 6, profile_views: 3 });
    expect(r.latest_followers).toMatchObject({ date: "2026-09-25", value: 369 });
    expect(r.posts.map((x: { media_id: string }) => x.media_id)).toEqual(["m1", "m2"]);
    expect(r.coverage).toMatchObject({ requested_days: 25, covered_days: 3, complete: false });
    expect(r.provenance.data_from_runs).toEqual([{ run_id: 1, trigger: "cron", finished_at: "2026-09-25T10:00:05Z" }]);
    expect(r.provenance.connector).toMatchObject({ source: "ig", stale: false, last_success_run_id: 1 });
    expect(r.account).toContain("100000003");
    expect(r.notes[0]).toMatch(/America\/Los_Angeles/);
  });

  it("omits posts unless asked and pins latest_followers to a past end_date", async () => {
    const r = (await igInsights(D1(), { start_date: "2026-09-22", end_date: "2026-09-24" }, new Date("2026-10-08T12:00:00Z"))) as Record<string, any>;
    expect(r).not.toHaveProperty("posts");
    expect(r.latest_followers).toMatchObject({ date: "2026-09-24", value: 368 });
    expect(r.coverage).toEqual({ requested_days: 3, covered_days: 3, complete: true, missing_ranges: [] });
    expect(r.provenance.connector.stale).toBe(true);
  });

  it("fb_page_insights reports the follower snapshot even when Meta returns no series", async () => {
    const r = (await fbPageInsights(D1(), { start_date: "2026-09-22", end_date: "2026-09-25" }, NOW)) as Record<string, any>;
    expect(r.latest_followers).toMatchObject({ date: "2026-09-25", value: 141 });
    expect(r.totals).toEqual({});
    expect(r.daily).toEqual({ "2026-09-25": { followers_count: 141 } });
    expect(r.page).toContain("100000004");
  });

  it("reads each answer in one batch and never writes", async () => {
    await igInsights(D1(), { include_posts: true }, NOW);
    await fbPageInsights(D1(), {}, NOW);
    expect(db.batchCalls).toBe(2);
    expect(db.prepared.length).toBeGreaterThan(0);
    for (const sql of db.prepared) expect(sql.trimStart()).toMatch(/^SELECT\b/i);
  });
});

describe("/mcp tools/call ig_insights", () => {
  it("returns the stored data through the handler, and bad dates as isError", async () => {
    const env = {
      AUDIT_DB: asD1(new FakeD1()),
      SIGNALS_DB: D1(),
      ALLOWED_EMAILS: "admin@example.com",
      CONFIRM_HMAC_KEY: HMAC_KEY,
      GOOGLE_SA_JSON: "{}",
    } as unknown as Env;
    const ctx = { props: { email: "admin@example.com" }, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const call = async (args: Record<string, unknown>) => {
      const res = await mcpApiHandler.fetch(
        new Request("https://mcp.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ig_insights", arguments: args } }),
        }),
        env,
        ctx,
      );
      const text = await res.text();
      const line = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
      return JSON.parse(line).result as { content: { text: string }[]; isError?: boolean };
    };
    const ok = await call({ start_date: "2026-09-22", end_date: "2026-09-24" });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text).totals.reach).toBe(135);
    const bad = await call({ start_date: "2026-09-30", end_date: "2026-09-01" });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0].text).error).toMatch(/after end_date/);
  });
});
