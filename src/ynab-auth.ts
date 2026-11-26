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

// What gets encrypted into the bearer token issued back to the MCP client and
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

// Stash the parsed client authorize request in KV under a random state
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

const readState = async (
  state: string | null,
  request: Request,
  kv: KVNamespace,
): Promise<AuthRequest> => {
  if (!state) throw new Error("Missing state parameter");

  const stored = await kv.get(STATE_KEY(state));
  if (!stored) throw new Error("Invalid or expired state");

  const cookieHash = cookieFromRequest(request, SESSION_COOKIE);
  if (!cookieHash) throw new Error("Missing session-binding cookie");
  if (cookieHash !== (await sha256Hex(state))) {
    throw new Error("State token does not match session");
  }
  return JSON.parse(stored) as AuthRequest;
};

const consumeState = async (
  request: Request,
  kv: KVNamespace,
): Promise<AuthRequest> => {
  const state = new URL(request.url).searchParams.get("state");
  const oauthReq = await readState(state, request, kv);
  await kv.delete(STATE_KEY(state!));
  return oauthReq;
};

const errorResponse = (msg: string, status = 400) =>
  new Response(msg, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

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
    if (url.pathname === "/authorize" && request.method === "POST") {
      return handleConsent(request, env);
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }
    if (url.pathname === "/") {
      return new Response(
        "YNAB MCP connector. Add /mcp as a remote MCP server in your MCP client; you'll be walked through YNAB OAuth.",
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
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return errorResponse("Unknown client_id");

  const { state, cookie } = await storeState(oauthReq, env.OAUTH_KV);
  return new Response(renderConsentPage(oauthReq, client.clientName, state), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "Set-Cookie": cookie,
      ...CONSENT_PAGE_HEADERS,
    },
  });
};

// Anyone can register a client (dynamic registration, or a metadata document
// on their own domain) and send a user to /authorize. YNAB's own consent page
// names this connector, not that client, and YNAB can skip it for a user who
// approved us before. Without this step a link could hand the user's YNAB
// token to whoever registered the redirect_uri. See the MCP spec's
// "Confused Deputy Problem".
const handleConsent = async (
  request: Request,
  env: AuthEnv,
): Promise<Response> => {
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return errorResponse("Cross-origin request refused", 403);
  }
  const form = await request.formData();
  const state = form.get("state");

  let oauthReq: AuthRequest;
  try {
    oauthReq = await readState(
      typeof state === "string" ? state : null,
      request,
      env.OAUTH_KV,
    );
  } catch (e) {
    return errorResponse(
      `State validation failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (form.get("action") !== "approve") {
    await env.OAUTH_KV.delete(STATE_KEY(state as string));
    const denied = new URL(oauthReq.redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (oauthReq.state) denied.searchParams.set("state", oauthReq.state);
    if (oauthReq.issuer) denied.searchParams.set("iss", oauthReq.issuer);
    return new Response(null, {
      status: 302,
      headers: { Location: denied.href, "Set-Cookie": clearSessionCookie() },
    });
  }

  const location = ynabAuthorizeUrl({
    client_id: env.YNAB_CLIENT_ID,
    redirect_uri: new URL("/callback", request.url).href,
    state: state as string,
  });
  return new Response(null, { status: 302, headers: { Location: location } });
};

const CONSENT_PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  // Not no-referrer: that makes browsers send `Origin: null` on the form POST.
  "Referrer-Policy": "same-origin",
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Where the grant ends up. A client's name is self-chosen; the host of its
// redirect_uri is what it can't fake.
const describeUri = (uri: string): string => {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || u.protocol === "http:"
      ? u.host
      : `${u.protocol}//${u.host}`;
  } catch {
    return uri;
  }
};

export const renderConsentPage = (
  oauthReq: AuthRequest,
  clientName: string | undefined,
  state: string,
): string => {
  const name = clientName?.trim() || "An unnamed app";
  const dest = describeUri(oauthReq.redirectUri);
  const cimdHost = /^https:\/\//.test(oauthReq.clientId)
    ? describeUri(oauthReq.clientId)
    : null;
  const identity =
    cimdHost && cimdHost !== dest
      ? `<p>App identity published by <code>${escapeHtml(cimdHost)}</code>.</p>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect YNAB</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
  code { font-size: 1.05em; font-weight: 600; word-break: break-all; }
  .warn { border-left: 3px solid #c80; padding-left: .75rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .5rem 1.25rem; cursor: pointer; }
</style>
</head>
<body>
<h1>Connect YNAB?</h1>
<p><strong>${escapeHtml(name)}</strong> wants full read and write access to your YNAB plans.</p>
<p>If you approve, access is sent to <code>${escapeHtml(dest)}</code>.</p>
${identity}
<p class="warn">Approve only if you just started connecting YNAB in this app yourself. If a link from someone else brought you here, cancel.</p>
<form method="post" action="/authorize">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<div class="actions">
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="cancel">Cancel</button>
</div>
</form>
</body>
</html>`;
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
