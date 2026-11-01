import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { buildServer } from "./server";
import { ynabAuthHandler, type AuthEnv, type Props } from "./ynab-auth";
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
}

const MCP_ROUTE = "/mcp";

// Browser Origins allowed to call /mcp. Non-browser clients (Claude.ai's
// connector backend, Claude Code) send no Origin and are unaffected. An
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
    const props = ctx.props as Props;
    if (ynabTokenExpired(props)) {
      return expiredTokenResponse(resourceMetadataUrl(env.MCP_RESOURCE));
    }
    const handler = createMcpHandler(() => buildServer(props), {
      route: MCP_ROUTE,
      allowedOriginHostnames: ALLOWED_ORIGIN_HOSTNAMES,
    });
    return handler(request, env, ctx);
  },
};

// Claude.ai discovers the authorization endpoints via RFC 9728
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

// The provider's configuration depends on env (the canonical resource), so
// build it once per isolate on first request.
let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request, env, ctx) {
    provider ??= createProvider(env);
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
