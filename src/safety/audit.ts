import { canonicalJson } from "./confirm";

export type AuditResult = "pending" | "success" | "error" | "indeterminate" | "rejected_drift";

export interface AuditStart {
  email: string;
  tool: string;
  pendingId: string;
  payload: unknown;
  before: unknown;
  credential: string;
}

const enc = (v: unknown) => (v === undefined ? null : canonicalJson(v));

export async function startAudit(db: D1Database, e: AuditStart & { result: AuditResult; after?: unknown }, now: Date): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO audit_log (at, email, tool, pending_id, payload_json, before_json, after_json, result, credential)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(now.toISOString(), e.email, e.tool, e.pendingId, canonicalJson(e.payload), canonicalJson(e.before), enc(e.after), e.result, e.credential)
    .first<{ id: number }>();
  if (!row) throw new Error("audit insert returned no id");
  return row.id;
}

export async function finishAudit(
  db: D1Database,
  id: number,
  e: { result: Exclude<AuditResult, "pending">; after?: unknown; error?: string },
): Promise<void> {
  await db
    .prepare(`UPDATE audit_log SET result = ?, after_json = ?, error = ? WHERE id = ? AND result = 'pending'`)
    .bind(e.result, enc(e.after), e.error ?? null, id)
    .run();
}

interface AuditRow {
  id: number;
  at: string;
  email: string;
  tool: string;
  payload_json: string;
  before_json: string;
  after_json: string | null;
  result: string;
  error: string | null;
  credential: string;
}

export async function listChanges(db: D1Database, opts: { limit: number; tool?: string }) {
  const { results } = opts.tool
    ? await db.prepare(`SELECT * FROM audit_log WHERE tool = ? ORDER BY id DESC LIMIT ?`).bind(opts.tool, opts.limit).all<AuditRow>()
    : await db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).bind(opts.limit).all<AuditRow>();
  return results.map((r) => ({
    id: r.id,
    at: r.at,
    email: r.email,
    tool: r.tool,
    result: r.result,
    error: r.error,
    credential: r.credential,
    payload: JSON.parse(r.payload_json),
    before: JSON.parse(r.before_json),
    after: r.after_json === null ? null : JSON.parse(r.after_json),
  }));
}
