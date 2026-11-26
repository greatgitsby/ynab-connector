# Development

First-time Cloudflare and YNAB app setup is in the [README](../../README.md#one-time-setup).

## Local Worker

```bash
cp .dev.vars.example .dev.vars   # YNAB_CLIENT_ID, YNAB_CLIENT_SECRET, MCP_RESOURCE
bun run dev                      # localhost:8787
```

`.dev.vars` must set `MCP_RESOURCE=http://localhost:8787/mcp`, because tokens are bound to it.
`bun run dev` passes `--local-upstream localhost:8787`; without it, wrangler rewrites the host to
the custom-domain route and local OAuth discovery breaks.

Bun runs dependency install scripts only for trusted packages. `trustedDependencies` in
`package.json` lists `esbuild` and `workerd`, which wrangler needs.

Wrangler still runs on Node (22.12 or later), even through `bun run` and `bunx`.

Bun is the package manager, script runner, test runner (`bun test`), type checker (`bun check`), and
formatter (`bun fmt`); oxlint lints. The Worker itself still runs on workerd, so worker code must
not use Bun APIs. That is why type-checking is split: `tsconfig.json` covers worker code without
Bun's types, and `tsconfig.test.json` adds them for tests and evals.

After changing `wrangler.jsonc`, run `bun run cf-typegen` to regenerate
`worker-configuration.d.ts`.

Driving MCP end to end locally needs MCP-client OAuth 2.1 with PKCE, which is awkward to
script. `bunx @modelcontextprotocol/inspector` against `http://localhost:8787/mcp` works, but
usually the deployed Worker plus a real client is easier. `bunx wrangler tail` streams its logs.

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

`patch`, `put`, and `post` write to YNAB. Point them only at a separate test plan, never a real one.

## Evals

`bun run eval` runs `evals/*.eval.ts`: failures from real agent runs, replayed through the MCP client against a fixture plan with the clock frozen. They grade the outcome an agent needs, so a new case can land failing before its fix; that is why they stay out of `bun test`. Add a failure as a fixture row plus one `test`. Build fixtures from a read-only look at a real plan; never write to one.

## Deploying

```bash
bunx wrangler secret put YNAB_CLIENT_ID      # once, and on rotation
bunx wrangler secret put YNAB_CLIENT_SECRET
bun run deploy
bunx wrangler tail                            # watch live requests
```

Remote consumers read the deployed Worker, so changes reach them only after a deploy.
