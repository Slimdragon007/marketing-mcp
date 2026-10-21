import { createMcpHandler } from "@modelcontextprotocol/server";
import { isAllowed } from "./auth/allowlist";
import type { AuthProps, Env } from "./env";
import { GoogleClient } from "./google/client";
import { buildServer } from "./server";

export const mcpApiHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Re-checked per request so removing an email from ALLOWED_EMAILS cuts off live tokens.
    const email = (ctx.props as AuthProps | undefined)?.email;
    if (!isAllowed(email, env.ALLOWED_EMAILS)) return Response.json({ error: "forbidden" }, { status: 403 });
    let google: GoogleClient | undefined;
    const server = buildServer({
      db: env.AUDIT_DB,
      signalsDb: env.SIGNALS_DB,
      google: () => (google ??= new GoogleClient(env.GOOGLE_SA_JSON)),
      email: email!,
      hmacKey: env.CONFIRM_HMAC_KEY,
      now: () => new Date(),
    });
    return createMcpHandler(() => server).fetch(req);
  },
};
