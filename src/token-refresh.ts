import {
  GrantType,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { refreshYnabToken, YnabError } from "./ynab";
import { PropsSchema, type Props } from "./ynab-auth";

export const EXPIRY_MARGIN_SECONDS = 300;
// The provider rejects TTLs under 60s (KV's minimum expiration).
const MIN_TTL_SECONDS = 60;
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
): Promise<TokenExchangeCallbackResult | undefined> => {
  const parsed = PropsSchema.safeParse(opts.props);
  if (!parsed.success) {
    throw new OAuthError("invalid_grant", {
      description:
        "This connection is missing its YNAB tokens. Authorize again.",
    });
  }
  const props = parsed.data;
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
      description:
        "Could not refresh the YNAB access token. Try again shortly.",
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

export const ynabTokenExpired = (props: Props, now = nowSeconds()) =>
  props.ynabExpiresAt <= now;

export const expiredTokenResponse = (resourceMetadataUrl: string) =>
  new Response(
    JSON.stringify({
      error: "invalid_token",
      error_description:
        "The upstream YNAB token has expired; refresh required.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="The upstream YNAB token has expired"`,
      },
    },
  );
