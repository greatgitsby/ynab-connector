import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  YnabClient,
  exchangeYnabCode,
  ynabAuthorizeUrl,
  YnabError,
} from "./ynab";

// Env fields this handler needs from wrangler config + secrets.
export interface AuthEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  YNAB_CLIENT_ID: string;
  YNAB_CLIENT_SECRET: string;
}

// What gets encrypted into the bearer token issued back to Claude.ai and
// surfaces as `this.props` inside YnabMcp.
export interface Props {
  ynabUserId: string;
  ynabAccessToken: string;
  ynabRefreshToken: string;
  // unix seconds; tools refresh proactively or reactively on 401.
  ynabExpiresAt: number;
  // True when the YNAB token was issued with write scope. Absent on tokens
  // issued before write support shipped — treated as false by write tools.
  canWrite?: boolean;
  [key: string]: unknown;
}

const STATE_TTL = 600; // 10 min — covers a slow user typing their YNAB password.
const STATE_KEY = (token: string) => `oauth:state:${token}`;

const cookieFromRequest = (req: Request, name: string): string | null => {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
};

const SESSION_COOKIE = "__Host-YNAB_STATE";

const setSessionCookie = (stateHash: string) =>
  `${SESSION_COOKIE}=${stateHash}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_TTL}`;

const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

const sha256Hex = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// Stash the parsed Claude.ai authorize request in KV under a random state
// token, and return the hash of that token so we can bind it to the user's
// session via cookie. The hash-in-cookie pattern means a leaked state in
// referrer logs alone can't complete the flow.
const storeState = async (
  req: AuthRequest,
  kv: KVNamespace,
): Promise<{ state: string; cookie: string }> => {
  const state = crypto.randomUUID();
  await kv.put(STATE_KEY(state), JSON.stringify(req), {
    expirationTtl: STATE_TTL,
  });
  const cookie = setSessionCookie(await sha256Hex(state));
  return { state, cookie };
};

const consumeState = async (
  request: Request,
  kv: KVNamespace,
): Promise<AuthRequest> => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) throw new Error("Missing state parameter");

  const stored = await kv.get(STATE_KEY(state));
  if (!stored) throw new Error("Invalid or expired state");

  const cookieHash = cookieFromRequest(request, SESSION_COOKIE);
  if (!cookieHash) throw new Error("Missing session-binding cookie");
  if (cookieHash !== (await sha256Hex(state))) {
    throw new Error("State token does not match session");
  }
  await kv.delete(STATE_KEY(state));
  return JSON.parse(stored) as AuthRequest;
};

const errorResponse = (msg: string, status = 400) =>
  new Response(msg, { status, headers: { "content-type": "text/plain" } });

// Exported as the OAuthProvider's defaultHandler. It owns every URL that the
// provider doesn't claim itself (/.well-known/*, /authorize, /token, /register
// are all handled by the provider before we see them — actually /authorize
// is mounted on us; the provider just routes there).
export const ynabAuthHandler = {
  async fetch(
    request: Request,
    env: AuthEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }
    if (url.pathname === "/") {
      return new Response(
        "YNAB MCP connector. Configure as a custom connector in Claude.ai pointed at /mcp; you'll be walked through YNAB OAuth.",
        { headers: { "content-type": "text/plain" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};

const handleAuthorize = async (
  request: Request,
  env: AuthEnv,
): Promise<Response> => {
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e) {
    return errorResponse(
      `Invalid authorize request: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!oauthReq.clientId) return errorResponse("Missing client_id");

  const { state, cookie } = await storeState(oauthReq, env.OAUTH_KV);
  const redirectUri = new URL("/callback", request.url).href;
  const location = ynabAuthorizeUrl({
    client_id: env.YNAB_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": cookie },
  });
};

const handleCallback = async (
  request: Request,
  env: AuthEnv,
): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    const err = url.searchParams.get("error_description") ??
      url.searchParams.get("error") ??
      "Missing code parameter";
    return errorResponse(`YNAB returned: ${err}`);
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = await consumeState(request, env.OAUTH_KV);
  } catch (e) {
    return errorResponse(
      `State validation failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let tokens;
  try {
    tokens = await exchangeYnabCode({
      client_id: env.YNAB_CLIENT_ID,
      client_secret: env.YNAB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", request.url).href,
    });
  } catch (e) {
    if (e instanceof YnabError) {
      return errorResponse(`Token exchange failed: ${e.status} ${e.body}`, 502);
    }
    throw e;
  }

  // YNAB user id is stable per account — use it both as the OAuth userId and
  // as a prop so tools can log/identify the active user.
  const { data } = await new YnabClient(tokens.access_token).getUser();
  const ynabUserId = data.user.id;
  const ynabExpiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

  const props: Props = {
    ynabUserId,
    ynabAccessToken: tokens.access_token,
    ynabRefreshToken: tokens.refresh_token,
    ynabExpiresAt,
    canWrite: true,
  };

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: ynabUserId,
    metadata: { label: `YNAB user ${ynabUserId}` },
    scope: oauthReq.scope,
    props,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      "Set-Cookie": clearSessionCookie(),
    },
  });
};
