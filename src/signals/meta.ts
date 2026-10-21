// Instagram and Facebook Page reads, ported from marketing-signals (src/tools.ts) so the
// output shape is identical. Data comes from the signals Worker's D1 (binding SIGNALS_DB),
// which its daily cron fills. This module only ever SELECTs from it.

import { InputError } from "../targets";

export const STALE_AFTER_HOURS = 26;
export const MAX_RANGE_DAYS = 1200;

type Row = Record<string, unknown>;
type Platform = "ig" | "fb";

interface SuccessRun {
  id: number;
  trigger: string;
  finished_at: string;
  window_start: string;
  window_end: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// Every answer is read in one D1 batch, which runs as a single transaction, so
// totals, rows, coverage and provenance all describe the same publication.
async function snapshot(db: D1Database, stmts: D1PreparedStatement[]): Promise<Row[][]> {
  const res = await db.batch<Row>(stmts);
  return res.map((r) => r.results ?? []);
}

function sourceStatements(db: D1Database, source: Platform): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT id, trigger, finished_at, window_start, window_end FROM sync_runs
         WHERE source = ? AND status = 'success' ORDER BY id`,
      )
      .bind(source),
    db
      .prepare(
        `SELECT id, status, started_at, finished_at, rows_written, error FROM sync_runs
         WHERE source = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(source),
  ];
}

function ageHours(iso: string, now: Date): number {
  return Math.round(((now.getTime() - Date.parse(iso)) / 3_600_000) * 10) / 10;
}

function freshnessFrom(source: Platform, runs: SuccessRun[], now: Date) {
  const last = runs[runs.length - 1];
  const at = last?.finished_at ?? null;
  return {
    source,
    last_success_at: at,
    last_success_run_id: last?.id ?? null,
    stale: !at || ageHours(at, now) > STALE_AFTER_HOURS,
  };
}

function toRanges(days: string[]): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && addDays(last.end, 1) === d) last.end = d;
    else out.push({ start: d, end: d });
  }
  return out;
}

// A requested day no successful run covered is unknown, not zero.
export function coverageFrom(runs: SuccessRun[], start: string, end: string) {
  const covered = new Set<string>();
  for (const r of runs) {
    if (r.window_start > end || r.window_end < start) continue;
    const s = r.window_start > start ? r.window_start : start;
    const e = r.window_end < end ? r.window_end : end;
    for (const d of eachDay(s, e)) covered.add(d);
  }
  const days = eachDay(start, end);
  const missing = days.filter((d) => !covered.has(d));
  return {
    requested_days: days.length,
    covered_days: days.length - missing.length,
    complete: missing.length === 0,
    missing_ranges: toRanges(missing),
  };
}

function provenanceFrom(source: Platform, runs: SuccessRun[], used: Iterable<unknown>, now: Date) {
  const ids = new Set([...used].map(Number));
  return {
    data_from_runs: runs.filter((r) => ids.has(r.id)).map((r) => ({ run_id: r.id, trigger: r.trigger, finished_at: r.finished_at })),
    connector: freshnessFrom(source, runs, now),
  };
}

// `days` is a relative window ending at end_date (default yesterday), so a stored dashboard query never goes stale.
export function resolveRange(start?: string, end?: string, now: Date = new Date(), days?: number) {
  if (start !== undefined && days !== undefined) throw new InputError("pass start_date or days, not both");
  if (days !== undefined && (!Number.isInteger(days) || days < 1)) throw new InputError("days must be a positive integer");
  const e = end ?? addDays(todayUtc(now), -1);
  const s = start ?? addDays(e, -((days ?? 28) - 1));
  if (!isIsoDate(s) || !isIsoDate(e)) throw new InputError("dates must be YYYY-MM-DD");
  if (s > e) throw new InputError("start_date is after end_date");
  if (daysBetween(s, e) + 1 > MAX_RANGE_DAYS) throw new InputError(`ranges are limited to ${MAX_RANGE_DAYS} days`);
  return { start: s, end: e };
}

const SNAPSHOT_METRICS = new Set(["followers_count", "media_count", "follower_count"]);

async function metaReport(db: D1Database, platform: Platform, start: string, end: string, posts: number | null, now: Date) {
  const stmts = [
    ...sourceStatements(db, platform),
    db
      .prepare(`SELECT date, metric, value, run_id FROM meta_daily WHERE platform = ? AND date BETWEEN ? AND ? ORDER BY date`)
      .bind(platform, start, end),
    db
      .prepare(
        `SELECT date, value, run_id FROM meta_daily WHERE platform = ? AND metric = 'followers_count' AND date <= ?
         ORDER BY date DESC LIMIT 1`,
      )
      // A range reaching yesterday is a "now" question; today's snapshot is
      // dated in Meta's LA day, which can be after end_date.
      .bind(platform, end >= addDays(todayUtc(now), -1) ? "9999-12-31" : end),
  ];
  if (posts !== null) {
    stmts.push(
      db
        .prepare(
          `SELECT media_id, posted_at, media_product_type, permalink, substr(caption, 1, 140) AS caption,
             reach, views, likes, comments, saved, shares, total_interactions, run_id, synced_at
           FROM ig_posts WHERE substr(posted_at, 1, 10) BETWEEN ? AND ? ORDER BY reach DESC LIMIT ?`,
        )
        .bind(start, end, posts),
    );
  }
  const [runs, , rows, latest, postRows] = await snapshot(db, stmts);
  const success = runs as unknown as SuccessRun[];
  const daily: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  for (const r of rows as { date: string; metric: string; value: number }[]) {
    (daily[r.date] ??= {})[r.metric] = r.value;
    if (!SNAPSHOT_METRICS.has(r.metric)) totals[r.metric] = (totals[r.metric] ?? 0) + r.value;
  }
  const used = [...rows, ...latest, ...(postRows ?? [])].map((r) => r.run_id);
  return {
    range: { start, end },
    daily,
    totals,
    latest_followers: latest[0] ?? null,
    ...(posts !== null ? { posts: postRows } : {}),
    coverage: coverageFrom(success, start, end),
    provenance: provenanceFrom(platform, success, used, now),
  };
}

export async function igInsights(
  db: D1Database,
  args: { start_date?: string; end_date?: string; days?: number; include_posts?: boolean; posts_limit?: number },
  now: Date,
) {
  const { start, end } = resolveRange(args.start_date, args.end_date, now, args.days);
  return {
    account: "Instagram business account (100000003)",
    ...(await metaReport(db, "ig", start, end, args.include_posts ? (args.posts_limit ?? 10) : null, now)),
    notes: [
      "Days are Meta account days (America/Los_Angeles).",
      "totals sum daily values; reach and accounts_engaged summed across days over-count people seen on several days.",
      "follower_count is daily new followers (Meta keeps 30 days); followers_count is our daily snapshot of the total.",
      "latest_followers is the newest snapshot on or before end_date; posts carry lifetime metrics as of their run.",
    ],
  };
}

export async function fbPageInsights(db: D1Database, args: { start_date?: string; end_date?: string; days?: number }, now: Date) {
  const { start, end } = resolveRange(args.start_date, args.end_date, now, args.days);
  return {
    page: "Facebook Page (100000004)",
    ...(await metaReport(db, "fb", start, end, null, now)),
    notes: [
      "Meta can return empty daily series for a Page with no recent posts; followers_count is our own daily snapshot.",
    ],
  };
}
