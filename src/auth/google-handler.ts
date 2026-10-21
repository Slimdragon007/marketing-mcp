// Unprotected routes: /health, the consent page at /authorize, and Google's /callback.
// Flow: consent (per MCP client) -> Google sign-in -> allowlist check -> grant.

import { AuthorizationError, CimdFetchError, type AuthRequest, type ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { Env, FetchLike } from "../env";
import { checkGoogleClaims, decodeJwtPayload } from "./allowlist";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const html = (body: string, headers = new Headers(), status = 200) => {
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}button{font-size:1rem;padding:.5rem 1rem;margin-right:.5rem}</style>${body}`, {
    status,
    headers,
  });
};

const textError = (msg: string, status = 400) =>
  new Response(escape(msg), { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function consentPage(client: ClientInfo, request: AuthRequest, handle: string): string {
  const name = escape(client.clientName ?? client.clientId);
  const redirectHost = new URL(request.redirectUri).hostname;
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(redirectHost);
  const origin = client.clientId.startsWith("https://")
    ? `Published by <strong>${escape(new URL(client.clientId).hostname)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<title>Authorize ${name}</title>
<h1>Allow ${name} to use Marketing MCP?</h1>
<p>${origin} Access will be sent to <strong>${escape(redirectHost)}</strong>.</p>
${local ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>It will be able to read GA4 and Search Console data and request guarded changes. You will sign in with Google next; only allowlisted accounts get through.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form>`;
}

function redirectError(e: AuthorizationError): Response {
  const redirect = new URL(e.redirectUri!);
  redirect.searchParams.set("error", e.code);
  redirect.searchParams.set("error_description", e.description);
  if (e.state) redirect.searchParams.set("state", e.state);
  if (e.issuer) redirect.searchParams.set("iss", e.issuer);
  return Response.redirect(redirect.href, 302);
}

function denyToClient(original: AuthRequest, headers: Headers, description: string): Response {
  const redirect = new URL(original.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", description);
  redirect.searchParams.set("state", original.state);
  if (original.issuer) redirect.searchParams.set("iss", original.issuer);
  headers.set("Location", redirect.href);
  return new Response(null, { status: 302, headers });
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function handleAuthRoutes(req: Request, env: Env, fetchImpl: FetchLike = fetch): Promise<Response> {
  const url = new URL(req.url);
  const oauth = env.OAUTH_PROVIDER;

  try {
    if (url.pathname === "/authorize" && req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const client = await oauth.lookupClient(request.clientId);
      if (!client) return textError("Unknown OAuth client");
      const consent = await oauth.beginConsent(request);
      return html(consentPage(client, request, consent.handle), consent.headers);
    }

    if (url.pathname === "/authorize" && req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle);
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const google = new URL(GOOGLE_AUTH);
      google.search = new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: `${env.PUBLIC_ORIGIN}/callback`,
        response_type: "code",
        scope: "openid email",
        state,
        code_challenge: await s256(verifier),
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      headers.set("Location", google.href);
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === "/callback" && req.method === "GET") {
      const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error") || !code) return denyToClient(original, headers, "Google sign-in was cancelled");

      const res = await fetchImpl(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          redirect_uri: `${env.PUBLIC_ORIGIN}/callback`,
          code_verifier: data.verifier,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id_token?: string };
      if (!res.ok || !body.id_token) return textError(`Google token exchange failed (HTTP ${res.status})`, 502);

      const verdict = checkGoogleClaims(decodeJwtPayload(body.id_token), {
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        allowlist: env.ALLOWED_EMAILS,
        nowSec: Math.floor(Date.now() / 1000),
      });
      if (!verdict.ok) return denyToClient(original, headers, verdict.reason);

      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: verdict.email,
        metadata: {},
        scope: original.scope,
        props: { email: verdict.email },
      });
      headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers });
    }
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectUri) return redirectError(err);
    if (err instanceof AuthorizationError) return textError(err.description);
    if (err instanceof CimdFetchError) return textError("This app could not be verified.");
    throw err;
  }

  if (url.pathname === "/health") return Response.json({ ok: true, server: "marketing-mcp" });
  return textError("not found", 404);
}
