// Write-safety contract: a dry run issues a confirm_token bound to the caller,
// the tool, the exact payload, and a hash of the state it previewed. Executing
// requires that token once, within CONFIRM_TTL_MS. The single-use check is one
// conditional UPDATE in D1, which KV cannot do atomically.

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export type ConfirmFailure = "malformed" | "unknown" | "mismatch" | "bad_signature" | "expired" | "reused";

export class ConfirmError extends Error {
  constructor(readonly reason: ConfirmFailure) {
    super(MESSAGES[reason]);
  }
}

const MESSAGES: Record<ConfirmFailure, string> = {
  malformed: "confirm_token is not in the expected format",
  unknown: "confirm_token was not issued by this server",
  mismatch: "confirm_token does not match this tool, user, and payload; run the dry run again with the exact payload",
  bad_signature: "confirm_token signature is invalid",
  expired: "confirm_token expired; run the dry run again",
  reused: "confirm_token was already used; run the dry run again",
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function hmacHex(key: string, msg: string): Promise<string> {
  if (!key || key.length < 32) throw new Error("CONFIRM_HMAC_KEY must be set (32+ chars)");
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const signedFields = (r: { id: string; email: string; tool: string; payload_json: string; before_hash: string; expires_at: string }) =>
  [r.id, r.email, r.tool, r.payload_json, r.before_hash, r.expires_at].join("\n");

export interface IssueInput {
  email: string;
  tool: string;
  payload: unknown;
  before: unknown;
}

export async function issueConfirmToken(db: D1Database, key: string, input: IssueInput, now: Date) {
  const id = crypto.randomUUID();
  const payload_json = canonicalJson(input.payload);
  const before_json = canonicalJson(input.before);
  const before_hash = await sha256Hex(before_json);
  const expires_at = new Date(now.getTime() + CONFIRM_TTL_MS).toISOString();
  const sig = await hmacHex(key, signedFields({ id, email: input.email, tool: input.tool, payload_json, before_hash, expires_at }));
  await db
    .prepare(
      `INSERT INTO pending_writes (id, email, tool, payload_json, before_json, before_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.email, input.tool, payload_json, before_json, before_hash, now.toISOString(), expires_at)
    .run();
  return { confirm_token: `${id}.${sig}`, expires_at };
}

interface PendingRow {
  id: string;
  email: string;
  tool: string;
  payload_json: string;
  before_json: string;
  before_hash: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface Consumed {
  pendingId: string;
  before: unknown;
  beforeHash: string;
}

// A mismatched or forged token is refused without consuming the stored row.
export async function consumeConfirmToken(
  db: D1Database,
  key: string,
  input: { token: string; email: string; tool: string; payload: unknown },
  now: Date,
): Promise<Consumed> {
  const m = input.token.match(/^([0-9a-f-]{36})\.([0-9a-f]{64})$/);
  if (!m) throw new ConfirmError("malformed");
  const [, id, sig] = m;
  const row = await db.prepare(`SELECT * FROM pending_writes WHERE id = ?`).bind(id).first<PendingRow>();
  if (!row) throw new ConfirmError("unknown");
  if (row.email !== input.email || row.tool !== input.tool || row.payload_json !== canonicalJson(input.payload)) {
    throw new ConfirmError("mismatch");
  }
  if (!constantTimeEqual(sig, await hmacHex(key, signedFields(row)))) throw new ConfirmError("bad_signature");
  if (row.consumed_at) throw new ConfirmError("reused");
  const nowIso = now.toISOString();
  if (row.expires_at <= nowIso) throw new ConfirmError("expired");
  const res = await db
    .prepare(`UPDATE pending_writes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`)
    .bind(nowIso, id, nowIso)
    .run();
  if ((res.meta as { changes?: number }).changes !== 1) throw new ConfirmError("reused");
  return { pendingId: id, before: JSON.parse(row.before_json), beforeHash: row.before_hash };
}
