import {
  GrantType,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { refreshYnabToken, YnabError } from "./ynab";
import type { Props } from "./ynab-auth";

// YNAB access tokens last 2 hours and their refresh tokens rotate. The MCP
// server is stateless (a fresh McpServer per request), so the only durable
// home for the current YNAB tokens is the OAuth grant's `props`. The pattern:
//
//   1. The client's access token is issued with a TTL that ends a few minutes
//      before the YNAB access token inside it expires.
//   2. When it expires, the client refreshes it at /token. The provider calls
//      `ynabTokenExchange`, which refreshes the YNAB token and stores the new
//      pair as the grant's props.
//
// Every YNAB token refresh therefore happens in exactly one place, serialized
// by the client's own refresh. Concurrent tool calls never race to rotate the
// refresh token.

// Expire the client's token this long before the YNAB token it carries.
export const EXPIRY_MARGIN_SECONDS = 300;
// The provider rejects TTLs under 60s (KV's minimum expiration).
const MIN_TTL_SECONDS = 60;
// On a refresh, skip the YNAB round-trip if the current YNAB token still has
// at least this long to live.
const REUSE_THRESHOLD_SECONDS = 600;

const nowSeconds = () => Math.floor(Date.now() / 1000);

export const accessTokenTtlFor = (ynabExpiresAt: number, now = nowSeconds()) =>
  Math.max(MIN_TTL_SECONDS, ynabExpiresAt - now - EXPIRY_MARGIN_SECONDS);

export interface RefreshEnv {
  YNAB_CLIENT_ID: string;
  YNAB_CLIENT_SECRET: string;
}

export const ynabTokenExchange = async (
  opts: TokenExchangeCallbackOptions<RefreshEnv>,
): Promise<TokenExchangeCallbackResult | void> => {
  const props = opts.props as Props;
  const now = nowSeconds();

  if (opts.grantType === GrantType.AUTHORIZATION_CODE) {
    return { accessTokenTTL: accessTokenTtlFor(props.ynabExpiresAt, now) };
  }
  if (opts.grantType !== GrantType.REFRESH_TOKEN) return;

  if (props.ynabExpiresAt - now > REUSE_THRESHOLD_SECONDS) {
    return { accessTokenTTL: accessTokenTtlFor(props.ynabExpiresAt, now) };
  }

  let next;
  try {
    next = await refreshYnabToken({
      client_id: opts.env.YNAB_CLIENT_ID,
      client_secret: opts.env.YNAB_CLIENT_SECRET,
      refresh_token: props.ynabRefreshToken,
    });
  } catch (e) {
    // 400/401 from YNAB's token endpoint means the refresh token is dead
    // (revoked, rotated away, or the user de-authorized the app). Throwing
    // invalid_grant makes the provider revoke the grant so the client starts a
    // fresh authorization instead of retrying forever.
    if (e instanceof YnabError && (e.status === 400 || e.status === 401)) {
      throw new OAuthError("invalid_grant", {
        description: "YNAB access was revoked or expired. Authorize again.",
      });
    }
    throw new OAuthError("temporarily_unavailable", {
      description: "Could not refresh the YNAB access token. Try again shortly.",
      statusCode: 503,
    });
  }

  const ynabExpiresAt = now + next.expires_in;
  const newProps: Props = {
    ...props,
    ynabAccessToken: next.access_token,
    ynabRefreshToken: next.refresh_token,
    ynabExpiresAt,
  };
  return { newProps, accessTokenTTL: accessTokenTtlFor(ynabExpiresAt, now) };
};

// Grants issued before this module existed carry YNAB tokens that were never
// rotated, and access tokens with the provider's default 1-hour TTL. If the
// YNAB token inside a still-valid client token has already expired, answer
// 401 invalid_token so the client refreshes now (running ynabTokenExchange)
// rather than serving YNAB 401s until its own token runs out.
export const ynabTokenExpired = (props: Props, now = nowSeconds()) =>
  typeof props.ynabExpiresAt === "number" && props.ynabExpiresAt <= now;

export const expiredTokenResponse = (resourceMetadataUrl: string) =>
  new Response(
    JSON.stringify({
      error: "invalid_token",
      error_description: "The upstream YNAB token has expired; refresh required.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="The upstream YNAB token has expired"`,
      },
    },
  );
