import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fbPageInsights, igInsights } from "../signals/meta";
import { guarded, type ToolContext } from "./common";

// Reads the signals Worker's stored history, not a live API.
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const dateArg = z.string().describe("YYYY-MM-DD");
const daysArg = z.number().int().min(1).max(1200).describe("Last N complete days ending at end_date (default yesterday). Use instead of start_date.");

export function registerMetaTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "ig_insights",
    {
      description:
        "Instagram business account metrics per day (reach, views, profile views, website clicks, interactions, follower snapshot) and optionally top posts by reach. Synced daily by marketing-signals. Defaults to the last 28 complete days.",
      inputSchema: z.object({
        start_date: dateArg.optional(),
        end_date: dateArg.optional(),
        days: daysArg.optional(),
        include_posts: z.boolean().optional(),
        posts_limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: readOnly,
    },
    (a) => guarded(() => igInsights(ctx.signalsDb, a, ctx.now())),
  );

  server.registerTool(
    "fb_page_insights",
    {
      description:
        "Facebook Page: daily follower snapshot plus any daily Page metrics Meta returns. Synced daily by marketing-signals. Defaults to the last 28 complete days.",
      inputSchema: z.object({ start_date: dateArg.optional(), end_date: dateArg.optional(), days: daysArg.optional() }),
      annotations: readOnly,
    },
    (a) => guarded(() => fbPageInsights(ctx.signalsDb, a, ctx.now())),
  );
}
