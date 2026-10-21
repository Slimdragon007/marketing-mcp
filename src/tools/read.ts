import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ADMIN_RESOURCES, adminList, ga4, gsc, type AdminResource } from "../google/apis";
import { listChanges } from "../safety/audit";
import { resolveProperty, resolveSite } from "../targets";
import { guarded, propertyArg, siteArg, type ToolContext } from "./common";

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

const ga4Date = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/)
  .describe("YYYY-MM-DD, today, yesterday, or NdaysAgo");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const filterExpr = z.record(z.string(), z.unknown()).describe("GA4 FilterExpression JSON, passed through unchanged");

interface Ga4Response {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  rowCount?: number;
  metadata?: Record<string, unknown>;
}

function shapeGa4(body: Ga4Response | null) {
  const dims = body?.dimensionHeaders?.map((h) => h.name) ?? [];
  const mets = body?.metricHeaders?.map((h) => h.name) ?? [];
  const rows = (body?.rows ?? []).map((r) => {
    const out: Record<string, string | number> = {};
    dims.forEach((d, i) => (out[d] = r.dimensionValues?.[i]?.value ?? ""));
    mets.forEach((m, i) => (out[m] = Number(r.metricValues?.[i]?.value ?? 0)));
    return out;
  });
  const meta = body?.metadata ?? {};
  return {
    rows,
    row_count: body?.rowCount ?? 0,
    returned: rows.length,
    sampling: meta.samplingMetadatas ?? null,
    data_loss_from_other_row: meta.dataLossFromOtherRow ?? false,
    metadata: meta,
  };
}

const names = (xs: string[]) => xs.map((name) => ({ name }));

export function registerReadTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "ga4_report",
    {
      description:
        "Run a GA4 Data API report (runReport) on the main or shop property. Example: last 7 days of sessions by date: dimensions [date], metrics [sessions], start_date 7daysAgo, end_date yesterday. Returns rows, row_count, and sampling flags.",
      inputSchema: z.object({
        property: propertyArg,
        start_date: ga4Date,
        end_date: ga4Date,
        dimensions: z.array(z.string()).max(9).default([]),
        metrics: z.array(z.string()).min(1).max(10),
        dimension_filter: filterExpr.optional(),
        metric_filter: filterExpr.optional(),
        order_bys: z.array(z.record(z.string(), z.unknown())).optional().describe("GA4 OrderBy JSON objects"),
        limit: z.number().int().min(1).max(10_000).default(100),
      }),
      annotations: readOnly,
    },
    (a) =>
      guarded(async () => {
        const id = resolveProperty(a.property);
        const body = await ga4.runReport(ctx.google(), id, {
          dateRanges: [{ startDate: a.start_date, endDate: a.end_date }],
          dimensions: names(a.dimensions),
          metrics: names(a.metrics),
          dimensionFilter: a.dimension_filter,
          metricFilter: a.metric_filter,
          orderBys: a.order_bys,
          limit: a.limit,
        });
        return { property: id, ...shapeGa4(body as Ga4Response) };
      }),
  );

  server.registerTool(
    "ga4_realtime",
    {
      description: "GA4 realtime report (last 30 minutes) for the main or shop property, e.g. metrics [activeUsers] by dimensions [unifiedScreenName].",
      inputSchema: z.object({
        property: propertyArg,
        dimensions: z.array(z.string()).max(9).default([]),
        metrics: z.array(z.string()).min(1).max(10),
        limit: z.number().int().min(1).max(10_000).default(100),
      }),
      annotations: readOnly,
    },
    (a) =>
      guarded(async () => {
        const id = resolveProperty(a.property);
        const body = await ga4.runRealtimeReport(ctx.google(), id, {
          dimensions: names(a.dimensions),
          metrics: names(a.metrics),
          limit: a.limit,
        });
        return { property: id, ...shapeGa4(body as Ga4Response) };
      }),
  );

  server.registerTool(
    "ga4_admin_get",
    {
      description: "List GA4 Admin settings for a property: key_events, custom_dimensions, google_ads_links, or data_streams.",
      inputSchema: z.object({
        property: propertyArg,
        resource: z.enum(Object.keys(ADMIN_RESOURCES) as [AdminResource, ...AdminResource[]]),
      }),
      annotations: readOnly,
    },
    (a) =>
      guarded(async () => {
        const id = resolveProperty(a.property);
        const { items, truncated } = await adminList(ctx.google(), id, ADMIN_RESOURCES[a.resource]);
        return { property: id, resource: a.resource, count: items.length, truncated, items };
      }),
  );

  server.registerTool(
    "gsc_query",
    {
      description:
        "Search Console search analytics (searchanalytics.query): clicks, impressions, CTR, position for a site, optionally by query, page, country, device, or date. Data lags about 2-3 days.",
      inputSchema: z.object({
        site: siteArg,
        start_date: isoDate,
        end_date: isoDate,
        dimensions: z.array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"])).default([]),
        row_limit: z.number().int().min(1).max(25_000).default(100),
        search_type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web"),
        dimension_filter_groups: z.array(z.record(z.string(), z.unknown())).optional().describe("GSC dimensionFilterGroups JSON"),
      }),
      annotations: readOnly,
    },
    (a) =>
      guarded(async () => {
        const site = resolveSite(a.site);
        const body = await gsc.query(ctx.google(), site, {
          startDate: a.start_date,
          endDate: a.end_date,
          dimensions: a.dimensions,
          rowLimit: a.row_limit,
          type: a.search_type,
          dimensionFilterGroups: a.dimension_filter_groups,
        });
        const rows = (body?.rows as unknown[] | undefined) ?? [];
        return { site, row_count: rows.length, rows, response_aggregation_type: body?.responseAggregationType ?? null };
      }),
  );

  server.registerTool(
    "gsc_sitemaps_list",
    {
      description: "List sitemaps submitted for a Search Console site, with last submitted/downloaded times and error/warning counts.",
      inputSchema: z.object({ site: siteArg }),
      annotations: readOnly,
    },
    (a) =>
      guarded(async () => {
        const site = resolveSite(a.site);
        const body = await gsc.listSitemaps(ctx.google(), site);
        return { site, sitemaps: body?.sitemap ?? [] };
      }),
  );

  server.registerTool(
    "list_changes",
    {
      description: "Read the audit log of every write this server executed or attempted, newest first, with before/after values.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        tool: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => guarded(async () => ({ changes: await listChanges(ctx.db, { limit: a.limit, tool: a.tool }) })),
  );
}
