# Claude for YNAB

A remote MCP server on Cloudflare Workers that lets Claude read and edit a user's YNAB data. Claude.ai authenticates to us with OAuth 2.1; we authenticate to YNAB with OAuth 2.0. Per-user YNAB tokens live inside the bearer token we issue to Claude, never in our storage.

It runs in production at `https://claude-for-ynab.moen.ai/mcp` against real people's money. Treat writes accordingly.

Think of these instructions as good defaults, not hard rules. The developer's preferences override anything here. Prefer the smallest change that makes the correct behavior unsurprising, and fight scope creep.

## The ways to hurt yourself

1. **Changing `MCP_RESOURCE`.** Every token's audience is bound to `https://claude-for-ynab.moen.ai/mcp`. Any other production value signs every user out.
2. **Refreshing YNAB tokens anywhere but `src/token-refresh.ts`.** YNAB refresh tokens rotate. Refreshing inside a tool call races concurrent calls and strands the grant with a spent token.
3. **Skipping the write gate.** Every write handler checks `getProps().canWrite` before any YNAB call. Tokens from before write support deserialize with `canWrite === undefined`; treat that as `false`.
4. **Pruning `wrangler.jsonc` migrations.** Keep both migration entries, including the `v2` `deleted_classes` one. Cloudflare replays the history by tag.
5. **Writing to a real plan.** Smoke-test writes only against the dedicated test plan. See [development](docs/operations/development.md#smoke-testing-writes).
6. **Widening the write surface quietly.** Manual transaction creation, deletes, scheduled transactions, payee rename/merge, category rename/move, and goal edits are excluded on purpose. See [write tools](docs/internals/write-tools.md).

## Commands

```bash
npm run dev          # wrangler dev on localhost:8787
npm run type-check   # tsc --noEmit
npm test             # vitest, plain Node
npm run deploy       # wrangler deploy
```

Local setup, the YNAB token helper, and the write smoke test: [development](docs/operations/development.md).

## Verifying

- Run `npm run type-check` and `npm test` before you push.
- Test behavior that can break: compute logic, goal interpretation, request bodies, response interpretation, batch errors, and the `canWrite` gate. Leave out tests for what types already guarantee, render copy, and wiring.
- Extend before you add. Add a fixture row or assertion to the existing case when one fits.
- Every read tool's compute test parses its fixture result through the tool's zod schema. The SDK throws on a mismatch at call time.
- New tools go in `EXPECTED_TOOLS` in `src/server.test.ts`, which drives every tool through a real MCP client.
- Run `scripts/smoke-writes.sh` before any deploy that touches write tools.

## How it works

`src/index.ts` wraps everything in `workers-oauth-provider`. Its API handler builds a fresh, stateless MCP server per request (`buildServer(props)` in `src/server.ts`) from the decrypted token props. Each tool is one file in `src/tools/`, split into a pure compute (YNAB data to a typed result) and a pure render (result to text). Handlers fetch, compute, render, and return both the text and the typed result as `structuredContent`.

Architecture and its constraints: [overview](docs/internals/overview.md). Vocabulary: [glossary](docs/internals/glossary.md). YNAB wire traps: [YNAB API](docs/internals/ynab-api.md).

## Taste

- Say **Plan**, never "budget", except in YNAB wire fields (`budgeted`, `to_be_budgeted`, `on_budget`, …). See the [glossary](docs/internals/glossary.md).
- Copy the shape of `src/tools/reflect-income-expense.ts` for a read tool and `src/tools/assign-to-categories.ts` for a write tool.
- Result types are zod schemas; derive the TS type with `z.infer`. Never hand-write an interface beside a schema.
- Money stays in milliunits until render. Format with `fmtMoney`.
- Interpret goals through `interpretGoal` / `GoalView`, never raw `goal_*` fields. Filter through `src/predicates.ts`, not inline boolean expressions on the YNAB shape.
- Tool-local helpers stay in the tool file. `src/` holds only what several tools share.
- Default to no comment. Write one only for a constraint, a YNAB quirk, or an invariant the code can't show.

## Issues and pull requests

- Issues live in GitHub Issues on `greatgitsby/ynab-connector`; use `gh`. Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Never open a PR unless asked.
- Body: the problem in a sentence or two, then the fix. End with the model and harness that did the work.

## Documentation

Most code changes need no documentation change. Agents can read the code.

- `docs/internals/` is for decisions and their reasons, constraints that span files, and traps hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. Do not enumerate fields, narrate control flow, keep file catalogs, or append PR summaries.
- When a documented decision changes, rewrite or remove the affected text. Do not append another account of the new behavior.
- A local reason the code can't show goes in a short nearby comment. Link to source instead of copying it.
- `docs/operations/` holds maintainer setup, testing, and deploy procedures.
- `README.md`, `docs/index.md`, and `docs/privacy-policy.md` are user-facing. The last two publish to GitHub Pages; `docs/internals/`, `docs/operations/`, and `docs/README.md` are excluded in `docs/_config.yml`.

## Plans and work artifacts

Do not commit implementation plans, research notes, or scratch files. Track work in the GitHub issue that owns it. A merged PR is the implementation record.
