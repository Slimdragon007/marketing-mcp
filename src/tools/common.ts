import { z } from "zod";
import { ConfigError, GoogleApiError, type GoogleClient } from "../google/client";
import { ConfirmError } from "../safety/confirm";
import { LockBusyError, LockLostError } from "../safety/lock";
import { InputError } from "../targets";

export interface ToolContext {
  db: D1Database;
  signalsDb: D1Database;
  google: () => GoogleClient;
  email: string;
  hmacKey: string;
  now: () => Date;
}

export function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export const fail = (payload: unknown) => ({ ...json(payload), isError: true });

// Thrown by tool bodies for a structured failure, so the MCP result carries isError at the top level.
export class ToolFailure extends Error {
  constructor(readonly payload: unknown) {
    super("tool failure");
  }
}

// Expected failures go back to Claude as tool errors; anything else is a bug and surfaces as one.
export async function guarded(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof ToolFailure) return fail(err.payload);
    if (err instanceof GoogleApiError) return fail({ error: err.toJSON() });
    if (err instanceof LockBusyError || err instanceof LockLostError) return fail({ executed: false, error: err.message });
    if (err instanceof ConfirmError) return fail({ error: err.message, reason: err.reason });
    if (err instanceof InputError || err instanceof ConfigError) return fail({ error: err.message });
    throw err;
  }
}

export const propertyArg = z
  .string()
  .describe('GA4 property: "main" (www.example.com, 100000001), "shop" (shop.example.com, 100000002), or a numeric property id');
export const siteArg = z
  .string()
  .describe('Search Console site: "main" (https://www.example.com/), "shop" (https://shop.example.com/), sc-domain:<host>, or https://<host>/');
