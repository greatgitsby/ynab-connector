import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { buildServer } from "./server";
import { PropsSchema, ynabAuthHandler, type AuthEnv } from "./ynab-auth";
import {
  expiredTokenResponse,
  ynabTokenExchange,
  ynabTokenExpired,
} from "./token-refresh";

export interface Env extends AuthEnv {
  // The URL MCP clients connect to. workers-oauth-provider 1.x binds every
  // token's audience to it, so it must equal the resource existing grants
  // carry: the deployed value is set in wrangler.jsonc; `.dev.vars` overrides
  // it with http://localhost:8787/mcp for `wrangler dev`.
  MCP_RESOURCE: string;
  AUTH_RATE_LIMITER: RateLimit;
}

const MCP_ROUTE = "/mcp";

// Browser Origins allowed to call /mcp. Non-browser clients (hosted
// connector backends like Claude.ai's, CLI agents) send no Origin and are
// unaffected. An
// explicit list replaces the handler's defaults, so re-include localhost for
// MCP Inspector.
const ALLOWED_ORIGIN_HOSTNAMES = [
  ...localhostAllowedOrigins(),
  "claude.ai",
  "claude.com",
];

const resourceMetadataUrl = (resource: string) => {
  const u = new URL(resource);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
};

// OAuthProvider validates the bearer token before this runs and exposes the
// decrypted grant props on ctx.props. A fresh McpServer is built per request
// (createMcpHandler is stateless — no Durable Object, no session state).
const apiHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext & { props?: unknown },
  ): Promise<Response> {
    // Props that don't parse get the expired-token answer: the client's
    // refresh then fails ynabTokenExchange's parse, and the provider revokes
    // the grant so the user authorizes again.
    const parsed = PropsSchema.safeParse(ctx.props);
    if (!parsed.success || ynabTokenExpired(parsed.data)) {
      return expiredTokenResponse(resourceMetadataUrl(env.MCP_RESOURCE));
    }
    const props = parsed.data;
    const handler = createMcpHandler(() => buildServer(props), {
      route: MCP_ROUTE,
      allowedOriginHostnames: ALLOWED_ORIGIN_HOSTNAMES,
    });
    return handler(request, env, ctx);
  },
};

// The MCP client discovers the authorization endpoints via RFC 9728
// protected-resource metadata (served by OAuthProvider), registers itself
// dynamically, and walks the user through /authorize → YNAB → /callback.
// completeAuthorization() then issues an MCP bearer with the per-user YNAB
// tokens encrypted into `props`; ynabTokenExchange keeps them fresh.
export const createProvider = (env: Env) =>
  new OAuthProvider<Env>({
    apiRoute: MCP_ROUTE,
    apiHandler,
    defaultHandler: ynabAuthHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [],
    resourceMetadata: { resource: env.MCP_RESOURCE },
    tokenExchangeCallback: ynabTokenExchange,
    // Accept URL client_ids (Client ID Metadata Documents), the MCP auth
    // spec's preferred alternative to dynamic registration. Needs the
    // global_fetch_strictly_public compat flag (wrangler.jsonc).
    clientIdMetadataDocumentEnabled: true,
  });

// Anyone can call these without a token, and each call writes KV: a client
// registration that lives 90 days, or a pending authorization. /token is left
// out because hosted clients refresh every user's token from shared IPs.
const RATE_LIMITED_PATHS = new Set(["/register", "/authorize"]);

const rateLimited = async (request: Request, env: Env): Promise<boolean> => {
  if (!RATE_LIMITED_PATHS.has(new URL(request.url).pathname)) return false;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.AUTH_RATE_LIMITER.limit({ key: ip });
  return !success;
};

// The provider's configuration depends on env (the canonical resource), so
// build it once per isolate on first request.
let provider: OAuthProvider<Env> | undefined;

export default {
  async fetch(request, env, ctx) {
    if (await rateLimited(request, env)) {
      return new Response("Too many requests. Try again in a minute.", {
        status: 429,
        headers: { "content-type": "text/plain", "Retry-After": "60" },
      });
    }
    provider ??= createProvider(env);
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
