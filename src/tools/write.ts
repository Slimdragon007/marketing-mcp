import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GOOGLE_TIMEOUT_MS, GoogleApiError, type GoogleClient } from "../google/client";
import { ga4, gsc, type KeyEvent } from "../google/apis";
import { finishAudit, startAudit } from "../safety/audit";
import { LOCK_TTL_MS, LockLostError, acquireLock, releaseLock, renewLock } from "../safety/lock";
import { canonicalJson, consumeConfirmToken, issueConfirmToken, sha256Hex } from "../safety/confirm";
import { InputError, checkSitemapUrl, resolveProperty, resolveSite } from "../targets";
import { ToolFailure, guarded, propertyArg, siteArg, type ToolContext } from "./common";

type Plan = { noop: true; reason: string } | { noop: false; change: string };

// Every write tool is described by these steps; runWrite owns the safety contract.
interface WriteSpec<Raw, P> {
  name: string;
  normalize: (raw: Raw) => P;
  // Lock key for the one Google setting this payload touches.
  resource: (p: P) => string;
  readBefore: (g: GoogleClient, p: P) => Promise<unknown>;
  plan: (p: P, before: unknown) => Plan;
  mutate: (g: GoogleClient, p: P, before: unknown) => Promise<unknown>;
  // Optional read after a successful mutate. Its failure never turns a success into a failure.
  readAfter?: (g: GoogleClient, p: P) => Promise<unknown>;
}

const safetyArgs = {
  dry_run: z
    .boolean()
    .default(true)
    .describe("Default true: preview only. To execute, pass dry_run:false together with the confirm_token from the preview."),
  confirm_token: z
    .string()
    .optional()
    .describe("From this tool's dry run. Ask Michael in chat before using it. Execute = same arguments + dry_run:false + this token."),
};

const LEASE_MARGIN_MS = 15_000;

// 4xx (other than timeouts) means Google refused the request, so nothing changed.
const definitelyRejected = (e: GoogleApiError) => e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 408;

export async function runWrite<Raw, P>(
  spec: WriteSpec<Raw, P>,
  args: Raw & { dry_run?: boolean; confirm_token?: string },
  ctx: ToolContext,
) {
  const { dry_run, confirm_token, ...raw } = args;
  const payload = spec.normalize(raw as Raw);
  const g = ctx.google();
  const execute = dry_run === false;

  if (execute && !confirm_token) throw new InputError("dry_run:false needs the confirm_token from a dry run of the same change");
  if (!execute && confirm_token) {
    throw new InputError("This is a preview call (dry_run is true or omitted), so the confirm_token was not used. To execute, pass dry_run:false with it.");
  }

  if (!execute) {
    const before = await spec.readBefore(g, payload);
    const plan = spec.plan(payload, before);
    if (plan.noop) return { dry_run: true, tool: spec.name, no_change: true, reason: plan.reason, current: before };
    const { confirm_token: token, expires_at } = await issueConfirmToken(
      ctx.db,
      ctx.hmacKey,
      { email: ctx.email, tool: spec.name, payload, before },
      ctx.now(),
    );
    return {
      dry_run: true,
      tool: spec.name,
      change: plan.change,
      current: before,
      payload,
      confirm_token: token,
      expires_at,
      next: `Nothing has changed yet. To execute, call ${spec.name} again with the same arguments plus dry_run:false and confirm_token. Single use, expires ${expires_at}.`,
    };
  }

  // The lock is taken before the token is spent, so a busy setting leaves the token usable.
  const resource = spec.resource(payload);
  const holder = await acquireLock(ctx.db, resource, ctx.now());
  // After an unknown outcome the lock is left to expire, keeping the setting exclusive a while longer.
  let releaseOnExit = true;
  try {
    const consumed = await consumeConfirmToken(
      ctx.db,
      ctx.hmacKey,
      { token: confirm_token!, email: ctx.email, tool: spec.name, payload },
      ctx.now(),
    );
    const credential = g.credential("write");
    const base = { email: ctx.email, tool: spec.name, pendingId: consumed.pendingId, payload, credential };

    const current = await spec.readBefore(g, payload);
    if ((await sha256Hex(canonicalJson(current))) !== consumed.beforeHash) {
      await startAudit(ctx.db, { ...base, before: consumed.before, after: current, result: "rejected_drift" }, ctx.now());
      throw new ToolFailure({
        executed: false,
        error: "The setting changed after the dry run, so nothing was executed. Run the dry run again.",
        previewed: consumed.before,
        current,
      });
    }

    const auditId = await startAudit(ctx.db, { ...base, before: current, result: "pending" }, ctx.now());

    // Last check before Google: the lease must be ours and must outlast the Google call deadline.
    // A renewal reply that arrives late leaves too little lease, so it fails closed too.
    try {
      const renewedAt = ctx.now();
      await renewLock(ctx.db, resource, holder, renewedAt);
      if (ctx.now().getTime() - renewedAt.getTime() > LOCK_TTL_MS - GOOGLE_TIMEOUT_MS - LEASE_MARGIN_MS) {
        throw new LockLostError(resource);
      }
    } catch (err) {
      await finishAudit(ctx.db, auditId, { result: "error", error: "lease lost before the write; nothing executed" }).catch(() => {});
      throw err;
    }

    let result: unknown;
    try {
      result = await spec.mutate(g, payload, current);
    } catch (err) {
      const rejected = err instanceof GoogleApiError && definitelyRejected(err);
      const detail = err instanceof GoogleApiError ? err.toJSON() : { message: String(err) };
      if (!rejected) releaseOnExit = false;
      await finishAudit(ctx.db, auditId, { result: rejected ? "error" : "indeterminate", error: JSON.stringify(detail) }).catch(() => {});
      throw new ToolFailure(
        rejected
          ? { executed: false, error: detail, audit_id: auditId, note: "Google refused the change. The confirm_token is spent; dry-run again to retry." }
          : {
              executed: "unknown",
              error: detail,
              audit_id: auditId,
              note: "The outcome is unknown: Google may have applied the change. Check the current value with a read tool before any retry.",
            },
      );
    }

    let after = result;
    let readback_error: unknown;
    if (spec.readAfter) {
      try {
        after = await spec.readAfter(g, payload);
      } catch (err) {
        readback_error = err instanceof GoogleApiError ? err.toJSON() : String(err);
      }
    }
    let audit_recorded = true;
    await finishAudit(ctx.db, auditId, {
      result: "success",
      after,
      error: readback_error ? `readback failed: ${JSON.stringify(readback_error)}` : undefined,
    }).catch(() => (audit_recorded = false));
    return {
      executed: true,
      tool: spec.name,
      before: current,
      after,
      credential,
      audit_id: auditId,
      ...(readback_error ? { readback_error } : {}),
      ...(audit_recorded ? {} : { audit_warning: `Change applied, but audit row ${auditId} could not be finalized; it still shows pending.` }),
    };
  } finally {
    if (releaseOnExit) await releaseLock(ctx.db, resource, holder).catch(() => {});
  }
}

const eventName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "GA4 event names: letters, digits, underscores, max 40");
const countingMethod = z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]);

type KeyEventArgs = {
  property: string;
  event_name: string;
  action: "mark" | "unmark";
  counting_method?: KeyEvent["countingMethod"];
};

export const keyEventSpec: WriteSpec<KeyEventArgs, KeyEventArgs> = {
  name: "ga4_key_event_upsert",
  normalize: (r) => ({
    property: resolveProperty(r.property),
    event_name: r.event_name,
    action: r.action,
    counting_method: r.action === "mark" ? (r.counting_method ?? "ONCE_PER_EVENT") : undefined,
  }),
  resource: (p) => `ga4:${p.property}:keyEvent:${p.event_name}`,
  readBefore: async (g, p) => {
    const k = await ga4.findKeyEvent(g, p.property, p.event_name);
    return k ? { name: k.name, eventName: k.eventName, countingMethod: k.countingMethod, deletable: k.deletable ?? true } : null;
  },
  plan: (p, before) => {
    const k = before as { countingMethod: string; deletable: boolean } | null;
    if (p.action === "mark") {
      if (!k) return { noop: false, change: `Mark "${p.event_name}" as a key event (${p.counting_method}) on property ${p.property}` };
      if (k.countingMethod === p.counting_method) return { noop: true, reason: `"${p.event_name}" is already a key event with ${k.countingMethod}` };
      return { noop: false, change: `Change "${p.event_name}" counting method ${k.countingMethod} -> ${p.counting_method} on property ${p.property}` };
    }
    if (!k) return { noop: true, reason: `"${p.event_name}" is not a key event on property ${p.property}` };
    if (!k.deletable) return { noop: true, reason: `Google reports "${p.event_name}" as not deletable` };
    return { noop: false, change: `Unmark "${p.event_name}" as a key event on property ${p.property}` };
  },
  mutate: async (g, p, before) => {
    const k = before as { name: string } | null;
    if (p.action === "unmark") {
      await ga4.deleteKeyEvent(g, k!.name);
      return null;
    }
    return k
      ? ga4.patchKeyEventCounting(g, k.name, p.counting_method!)
      : ga4.createKeyEvent(g, p.property, p.event_name, p.counting_method!);
  },
};

type CustomDimArgs = { property: string; parameter_name: string; display_name: string; description?: string };

export const customDimensionSpec: WriteSpec<CustomDimArgs, CustomDimArgs> = {
  name: "ga4_custom_dimension_create",
  normalize: (r) => ({ ...r, property: resolveProperty(r.property) }),
  resource: (p) => `ga4:${p.property}:customDimension:${p.parameter_name}`,
  readBefore: async (g, p) => {
    const d = await ga4.findCustomDimension(g, p.property, p.parameter_name);
    return d ? { name: d.name, parameterName: d.parameterName, displayName: d.displayName, scope: d.scope } : null;
  },
  plan: (p, before) =>
    before
      ? { noop: true, reason: `An event-scoped dimension for "${p.parameter_name}" already exists` }
      : {
          noop: false,
          change: `Create event-scoped custom dimension "${p.display_name}" for parameter "${p.parameter_name}" on property ${p.property}. GA4 custom dimensions cannot be deleted, only archived in the GA4 UI, and count toward the 50-per-property limit.`,
        },
  mutate: (g, p) =>
    ga4.createCustomDimension(g, p.property, {
      parameterName: p.parameter_name,
      displayName: p.display_name,
      description: p.description,
    }),
};

type SitemapArgs = { site: string; sitemap_url: string };

const sitemapNormalize = (r: SitemapArgs): SitemapArgs => {
  const site = resolveSite(r.site);
  return { site, sitemap_url: checkSitemapUrl(site, r.sitemap_url) };
};
// Only stable fields: Google's lastDownloaded can change between dry run and confirm.
const sitemapResource = (p: SitemapArgs) => `gsc:${p.site}:sitemap:${p.sitemap_url}`;
const sitemapBefore = async (g: GoogleClient, p: SitemapArgs) => {
  const s = await gsc.getSitemap(g, p.site, p.sitemap_url);
  return s ? { exists: true, path: s.path } : { exists: false, path: p.sitemap_url };
};

export const sitemapSubmitSpec: WriteSpec<SitemapArgs, SitemapArgs> = {
  name: "gsc_sitemap_submit",
  normalize: sitemapNormalize,
  resource: sitemapResource,
  readBefore: sitemapBefore,
  plan: (p, before) => ({
    noop: false,
    change: `${(before as { exists: boolean }).exists ? "Resubmit" : "Submit"} sitemap ${p.sitemap_url} to Search Console site ${p.site}`,
  }),
  mutate: (g, p) => gsc.submitSitemap(g, p.site, p.sitemap_url),
  readAfter: (g, p) => gsc.getSitemap(g, p.site, p.sitemap_url),
};

export const sitemapDeleteSpec: WriteSpec<SitemapArgs, SitemapArgs> = {
  name: "gsc_sitemap_delete",
  normalize: sitemapNormalize,
  resource: sitemapResource,
  readBefore: sitemapBefore,
  plan: (p, before) =>
    (before as { exists: boolean }).exists
      ? { noop: false, change: `Remove sitemap ${p.sitemap_url} from Search Console site ${p.site}. Resubmitting restores it.` }
      : { noop: true, reason: `${p.sitemap_url} is not submitted for ${p.site}` },
  mutate: async (g, p) => {
    await gsc.deleteSitemap(g, p.site, p.sitemap_url);
    return null;
  },
};

export function registerWriteTools(server: McpServer, ctx: ToolContext) {
  const reversible = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
  const removes = { ...reversible, destructiveHint: true } as const;

  server.registerTool(
    keyEventSpec.name,
    {
      description:
        "Mark or unmark a GA4 event as a key event, or change its counting method. Dry run by default: returns the change, the current value, and a confirm_token.",
      inputSchema: z.object({
        property: propertyArg,
        event_name: eventName,
        action: z.enum(["mark", "unmark"]),
        counting_method: countingMethod.optional().describe("For mark. Default ONCE_PER_EVENT."),
        ...safetyArgs,
      }),
      annotations: removes,
    },
    (a) => guarded(() => runWrite(keyEventSpec, a, ctx)),
  );

  server.registerTool(
    customDimensionSpec.name,
    {
      description:
        "Create an event-scoped GA4 custom dimension. Dry run by default. Note: GA4 custom dimensions cannot be deleted through this server.",
      inputSchema: z.object({
        property: propertyArg,
        parameter_name: eventName.describe("Event parameter name, e.g. print_sku"),
        display_name: z.string().min(1).max(82),
        description: z.string().max(150).optional(),
        ...safetyArgs,
      }),
      annotations: reversible,
    },
    (a) => guarded(() => runWrite(customDimensionSpec, a, ctx)),
  );

  const sitemapSchema = z.object({
    site: siteArg,
    sitemap_url: z.string().describe("Full https URL of the sitemap, inside the site"),
    ...safetyArgs,
  });

  server.registerTool(
    sitemapSubmitSpec.name,
    { description: "Submit (or resubmit) a sitemap to Search Console. Dry run by default.", inputSchema: sitemapSchema, annotations: reversible },
    (a) => guarded(() => runWrite(sitemapSubmitSpec, a, ctx)),
  );

  server.registerTool(
    sitemapDeleteSpec.name,
    { description: "Remove a sitemap from Search Console. Dry run by default.", inputSchema: sitemapSchema, annotations: removes },
    (a) => guarded(() => runWrite(sitemapDeleteSpec, a, ctx)),
  );
}

