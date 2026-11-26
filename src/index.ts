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
  MCP_RESOURCE: string;
  AUTH_RATE_LIMITER: RateLimit;
}

const MCP_ROUTE = "/mcp";

// Browser Origins allowed to call /mcp. Non-browser clients, such as hosted
// connector backends and CLI agents, send no Origin and are unaffected. An
// explicit list replaces the handler's defaults, so localhost is listed again
// for MCP Inspector.
const ALLOWED_ORIGIN_HOSTNAMES = [
  ...localhostAllowedOrigins(),
  "claude.ai",
  "claude.com",
];

const resourceMetadataUrl = (resource: string) => {
  const u = new URL(resource);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
};

const apiHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext & { props?: unknown },
  ): Promise<Response> {
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

const createProvider = (env: Env) =>
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
