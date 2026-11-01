# Development

First-time Cloudflare and YNAB app setup is in the [README](../../README.md#one-time-setup).

## Local Worker

```bash
cp .dev.vars.example .dev.vars   # YNAB_CLIENT_ID, YNAB_CLIENT_SECRET, MCP_RESOURCE
npm run dev                      # localhost:8787
```

`.dev.vars` must set `MCP_RESOURCE=http://localhost:8787/mcp`, because tokens are bound to it.
`npm run dev` passes `--local-upstream localhost:8787`; without it, wrangler rewrites the host to
the custom-domain route and local OAuth discovery breaks.

npm 11 blocks dependency install scripts unless allowed. `allowScripts` in `package.json` approves
`esbuild` and `workerd`, which wrangler needs.

After changing `wrangler.jsonc`, run `npx wrangler types` to regenerate
`worker-configuration.d.ts`.

Driving MCP end to end locally needs Claude.ai-style OAuth 2.1 with PKCE, which is awkward to
script. `npx @modelcontextprotocol/inspector` against `http://localhost:8787/mcp` works, but
usually the deployed Worker plus a real client is easier. `npx wrangler tail` streams its logs.

## Calling YNAB directly

To probe raw YNAB data, skip MCP and use `scripts/ynab.sh` with a user token.

```bash
./scripts/ynab.sh url               # print the authorize URL and visit it
# The redirect to localhost:8787/callback fails to load; copy `code` from the URL.
./scripts/ynab.sh exchange <CODE>   # saves tokens to .dev.vars.tokens (gitignored)

./scripts/ynab.sh api /plans
./scripts/ynab.sh api "/plans/$PLAN_ID/transactions?since_date=2026-01-01"
```

The helper adds the bearer header, refreshes when the saved expiry has passed, and retries once on
a 401. Extra arguments after the path go to `curl`.

## Smoke-testing writes

`scripts/smoke-writes.sh` round-trips a `budgeted` change and an approval toggle and exits non-zero
on any mismatch. Run it before any deploy that touches write tools.

1. Create a separate "Claude Connector Test" plan in YNAB with a few categories and transactions.
   Never point this at a real plan.
2. Put `YNAB_TEST_PLAN_ID=<plan id>` in `.dev.vars.smoke` (gitignored).
3. Run `./scripts/smoke-writes.sh`.

## Deploying

```bash
npx wrangler secret put YNAB_CLIENT_ID      # once, and on rotation
npx wrangler secret put YNAB_CLIENT_SECRET
npm run deploy
npx wrangler tail                            # watch live requests
```

Remote consumers read the deployed Worker, so changes reach them only after a deploy.
