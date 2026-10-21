// Routes:
//   /mcp                       MCP (streamable HTTP, stateless), OAuth bearer token required
//   /authorize, /callback      consent page + Google sign-in (allowlist: ALLOWED_EMAILS)
//   /oauth/token, /oauth/register, /.well-known/*   owned by workers-oauth-provider
//   /health                    open, no data

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthRoutes } from "./auth/google-handler";
import type { Env } from "./env";
import { mcpApiHandler } from "./mcp-handler";

const SCOPE = "mcp";

// The canonical resource URL comes from env, which only exists per request.
let provider: OAuthProvider<Env> | undefined;
function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: { fetch: (req, env) => handleAuthRoutes(req, env as Env) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE],
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}/mcp`,
      authorization_servers: [env.PUBLIC_ORIGIN],
      scopes_supported: [SCOPE],
      resource_name: "Marketing MCP",
    },
  });
  return provider;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
