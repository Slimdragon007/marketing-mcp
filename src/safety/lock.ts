export const LOCK_TTL_MS = 60 * 1000;

export class LockBusyError extends Error {
  constructor(readonly resource: string) {
    super(`Another change to ${resource} is in progress. Nothing was executed and the confirm_token was not used; try again shortly.`);
  }
}

// One conditional upsert: it takes a free or expired lock and changes nothing otherwise.
export async function acquireLock(db: D1Database, resource: string, now: Date): Promise<string> {
  const holder = crypto.randomUUID();
  const nowIso = now.toISOString();
  const res = await db
    .prepare(
      `INSERT INTO write_locks (resource, holder, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (resource) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE write_locks.expires_at <= ?`,
    )
    .bind(resource, holder, new Date(now.getTime() + LOCK_TTL_MS).toISOString(), nowIso)
    .run();
  if ((res.meta as { changes?: number }).changes !== 1) throw new LockBusyError(resource);
  return holder;
}

export async function releaseLock(db: D1Database, resource: string, holder: string): Promise<void> {
  await db.prepare(`DELETE FROM write_locks WHERE resource = ? AND holder = ?`).bind(resource, holder).run();
}

export class LockLostError extends Error {
  constructor(readonly resource: string) {
    super(`The lock on ${resource} expired before the write, so nothing was executed. Run the dry run again.`);
  }
}

// Called right before the mutation. Fails if this holder no longer owns a live lease,
// so a confirmation that stalled past the TTL can never write on a stale snapshot.
export async function renewLock(db: D1Database, resource: string, holder: string, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const res = await db
    .prepare(`UPDATE write_locks SET expires_at = ? WHERE resource = ? AND holder = ? AND expires_at > ?`)
    .bind(new Date(now.getTime() + LOCK_TTL_MS).toISOString(), resource, holder, nowIso)
    .run();
  if ((res.meta as { changes?: number }).changes !== 1) throw new LockLostError(resource);
}
