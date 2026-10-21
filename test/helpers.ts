import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Param = string | number | null;

// Test hook: runs after a statement executes and before its result is returned, like a slow D1 reply.
export type AfterHook = (sql: string) => Promise<void> | void;

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: Param[] = [],
    private readonly after?: () => AfterHook | undefined,
  ) {}
  bind(...params: Param[]) {
    return new FakeStatement(this.db, this.sql, params, this.after);
  }
  async first<T>() {
    const row = (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
    await this.after?.()?.(this.sql);
    return row as T | null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    await this.after?.()?.(this.sql);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

// Minimal D1 stand-in backed by node:sqlite so tests run the real migration SQL.
export class FakeD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  // Records every statement prepared, so tests can assert what a tool sent.
  readonly prepared: string[] = [];
  constructor(schema = "../migrations/0001_init.sql") {
    this.sqlite.exec(readFileSync(new URL(schema, import.meta.url), "utf8"));
  }
  batchCalls = 0;
  // Like D1: one transaction, every statement's rows returned in order.
  async batch(stmts: FakeStatement[]) {
    this.batchCalls++;
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  afterStatement?: AfterHook;
  prepare(sql: string) {
    this.prepared.push(sql);
    return new FakeStatement(this.sqlite, sql, [], () => this.afterStatement);
  }
  rows(sql: string) {
    return this.sqlite.prepare(sql).all() as Record<string, unknown>[];
  }
}

// The marketing-signals schema, copied from that repo's migrations/0001_init.sql.
export const signalsD1 = () => new FakeD1("./fixtures/signals-0001_init.sql");

export const asD1 = (db: FakeD1) => db as unknown as D1Database;

export const HMAC_KEY = "test-hmac-key-0123456789abcdef0123456789";

export async function fakeServiceAccountJson(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = Buffer.from(der).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ client_email: "mcp-test@example.iam.gserviceaccount.com", private_key: pem });
}

export interface Call {
  method: string;
  url: string;
  body?: string;
}

// Routes Google calls to handlers keyed by "METHOD url-prefix"; records every call.
export function fakeGoogle(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const call = { method: init.method ?? "GET", url, body: typeof init.body === "string" ? init.body : undefined };
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "tok" });
    calls.push(call);
    const key = Object.keys(routes).find((k) => {
      const [m, prefix] = k.split(" ");
      return m === call.method && url.startsWith(prefix);
    });
    if (!key) return Response.json({ error: { code: 404, message: `no fake for ${call.method} ${url}` } }, { status: 404 });
    return routes[key](call);
  };
  return { calls, fetchImpl };
}

export function parseResult(r: { content: { text: string }[]; isError?: boolean }) {
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) as Record<string, any> };
}
