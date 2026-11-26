import { describe, expect, it } from "bun:test";
import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { ynabAuthHandler, type AuthEnv } from "./ynab-auth";

const ORIGIN = "https://ynab.mcp.moen.ai";

const oauthReq: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://evil.example/cb?x=1",
  scope: [],
  state: "client-state",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
};

const makeEnv = (clientName = 'Claude <script>alert("x")</script>') => {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  const env = {
    OAUTH_KV: kv as unknown as KVNamespace,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => oauthReq,
      lookupClient: async () => ({
        clientId: "client-1",
        redirectUris: [oauthReq.redirectUri],
        clientName,
      }),
    } as unknown as OAuthHelpers,
    YNAB_CLIENT_ID: "ynab-client",
    YNAB_CLIENT_SECRET: "secret",
  } satisfies AuthEnv;
  return { env, store };
};

const ctx = {} as ExecutionContext;

const startFlow = async (env: AuthEnv) => {
  const res = await ynabAuthHandler.fetch(
    new Request(`${ORIGIN}/authorize?client_id=client-1`),
    env,
    ctx,
  );
  const html = await res.text();
  const state = /name="state" value="([^"]+)"/.exec(html)![1];
  const cookie = res.headers.get("Set-Cookie")!.split(";")[0];
  return { res, html, state, cookie };
};

const post = (
  fields: Record<string, string>,
  headers: Record<string, string>,
) =>
  new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(fields),
  });

describe("/authorize consent", () => {
  it("shows a consent page instead of redirecting to YNAB", async () => {
    const { env } = makeEnv();
    const { res, html } = await startFlow(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(html).toContain("<code>evil.example</code>");
    expect(html).toContain("Claude &#60;script&#62;");
    expect(html).not.toContain("<script>");
  });

  it("approval with the session cookie and same origin continues to YNAB", async () => {
    const { env, store } = makeEnv();
    const { state, cookie } = await startFlow(env);
    const res = await ynabAuthHandler.fetch(
      post({ state, action: "approve" }, { Origin: ORIGIN, Cookie: cookie }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(
      "https://app.ynab.com/oauth/authorize",
    );
    expect(loc.searchParams.get("state")).toBe(state);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    // /callback consumes it.
    expect(store.size).toBe(1);
  });

  it.each([
    ["a cross-origin post", { Origin: "https://evil.example" }, 403],
    ["a post with no Origin", {}, 403],
    ["a post without the session cookie", { Origin: ORIGIN }, 400],
  ])("refuses %s", async (_, headers: Record<string, string>, status) => {
    const { env } = makeEnv();
    const { state } = await startFlow(env);
    const res = await ynabAuthHandler.fetch(
      post({ state, action: "approve" }, headers),
      env,
      ctx,
    );
    expect(res.status).toBe(status);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("refuses another flow's cookie", async () => {
    const { env } = makeEnv();
    const victim = await startFlow(env);
    const other = await startFlow(env);
    const res = await ynabAuthHandler.fetch(
      post(
        { state: victim.state, action: "approve" },
        { Origin: ORIGIN, Cookie: other.cookie },
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("cancel returns access_denied to the client and drops the state", async () => {
    const { env, store } = makeEnv();
    const { state, cookie } = await startFlow(env);
    const res = await ynabAuthHandler.fetch(
      post({ state, action: "cancel" }, { Origin: ORIGIN, Cookie: cookie }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://evil.example/cb");
    expect(loc.searchParams.get("x")).toBe("1");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
    expect(store.size).toBe(0);
  });
});

describe("/callback errors", () => {
  it("echoes only an OAuth error code, never error_description", async () => {
    const { env } = makeEnv();
    const res = await ynabAuthHandler.fetch(
      new Request(
        `${ORIGIN}/callback?error=access_denied&error_description=Call+555-0100+to+unlock`,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain("(access_denied)");
    expect(body).not.toContain("555");
  });
});
