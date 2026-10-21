import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { mcpApiHandler } from "../src/mcp-handler";
import { FakeD1, HMAC_KEY, asD1, fakeGoogle, fakeServiceAccountJson, signalsD1 } from "./helpers";

const env = {
  AUDIT_DB: asD1(new FakeD1()),
  SIGNALS_DB: asD1(signalsD1()),
  ALLOWED_EMAILS: "owner@example.com,admin@example.com",
  CONFIRM_HMAC_KEY: HMAC_KEY,
  GOOGLE_SA_JSON: "{}",
} as unknown as Env;

const ctx = (props?: unknown) => ({ props, waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

const rpc = (body: unknown) =>
  new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

async function readJson(res: Response) {
  const text = await res.text();
  const data = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(data);
}

describe("/mcp handler", () => {
  it("refuses a token whose email is no longer allowlisted", async () => {
    const res = await mcpApiHandler.fetch(rpc({}), env, ctx({ email: "someone@gmail.com" }));
    expect(res.status).toBe(403);
    expect((await mcpApiHandler.fetch(rpc({}), env, ctx())).status).toBe(403);
  });

  it("lists exactly the Phase 1 tools plus the Meta reads", async () => {
    const init = await mcpApiHandler.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
      env,
      ctx({ email: "admin@example.com" }),
    );
    expect(init.status).toBe(200);
    const res = await mcpApiHandler.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, ctx({ email: "admin@example.com" }));
    const { result } = await readJson(res);
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "fb_page_insights",
      "ga4_admin_get",
      "ga4_custom_dimension_create",
      "ga4_key_event_upsert",
      "ga4_realtime",
      "ga4_report",
      "gsc_query",
      "gsc_sitemap_delete",
      "gsc_sitemap_submit",
      "gsc_sitemaps_list",
      "ig_insights",
      "list_changes",
    ]);
    const meta = result.tools.filter((t: { name: string }) => t.name.endsWith("_insights"));
    for (const t of meta) expect(t.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("/mcp tools/call", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a drift-rejected write comes back with top-level isError", async () => {
    const SITEMAP = "https://shop.example.com/sitemap.xml";
    const URL_ = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent("https://shop.example.com/")}/sitemaps/${encodeURIComponent(SITEMAP)}`;
    const state = { exists: false };
    const g = fakeGoogle({
      [`GET ${URL_}`]: () => (state.exists ? Response.json({ path: SITEMAP }) : new Response("", { status: 404 })),
      [`PUT ${URL_}`]: () => new Response("", { status: 200 }),
    });
    vi.stubGlobal("fetch", g.fetchImpl);
    const e = { ...env, AUDIT_DB: asD1(new FakeD1()), GOOGLE_SA_JSON: await fakeServiceAccountJson() } as Env;
    const c = ctx({ email: "admin@example.com" });
    const call = async (args: Record<string, unknown>) =>
      (await readJson(await mcpApiHandler.fetch(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gsc_sitemap_submit", arguments: args } }), e, c))).result;

    const dry = await call({ site: "shop", sitemap_url: SITEMAP });
    expect(dry.isError).toBeFalsy();
    const token = JSON.parse(dry.content[0].text).confirm_token;
    state.exists = true;
    const done = await call({ site: "shop", sitemap_url: SITEMAP, dry_run: false, confirm_token: token });
    expect(done.isError).toBe(true);
    expect(JSON.parse(done.content[0].text).executed).toBe(false);
    expect(g.calls.filter((x) => x.method === "PUT")).toHaveLength(0);
  });
});
