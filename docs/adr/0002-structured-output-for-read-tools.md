# ADR 0002: Structured output (`structuredContent` + `outputSchema`) for read tools

- **Status:** Accepted (2026-05-31)
- **Supersedes:** —
- **Related:** ADR 0001 (D8 "Response shape: text plus `structuredContent`", and its
  deferral of `outputSchema`), `CONTEXT.md` (Compute/Render split), `CLAUDE.md`
  (Tool conventions), `src/format.ts` (`result()` helper)

## Context

The connector's read tools return human-readable text only: each handler ends in
`text(render(computeResult))`. The pure `compute*` functions already produce a
single, fully-typed result object (`SpendingBreakdown`, `IncomeExpensePivot`,
`NetWorthReport`, …) — but the handler discards it, keeping only the rendered
string.

This surfaced as a real problem when building a **Cowork live artifact** (a
self-contained HTML dashboard that re-fetches from the connector on every open)
over `reflect_spending_breakdown` and `reflect_spending_trends`. With only text
to work from, the artifact had to regex-parse the rendered lines — stripping
emoji, re-parsing `$4,253.08` back into a number, and special-casing a
dollar-sign-inside-a-category-name bug (`Tuition ($4254)` mis-parsed as the
amount). That parsing layer is fragile by construction: any wording or format
change in a renderer silently breaks the consumer.

The write tools (ADR 0001 D8) already return `structuredContent` alongside text
via the `result(text, structured)` helper — but **without** an `outputSchema`,
which D8 explicitly deferred "until a client begins enforcing them." The live
artifact is that client: a structured-data consumer whose entire job is reading
these payloads. This ADR closes the deferral for the read surface.

MCP 2025-11-25 (`/specification/2025-11-25/server/tools`) governs the shape:

> Structured content is returned as a JSON object in the `structuredContent`
> field of a result. … For backwards compatibility, a tool that returns
> structured content SHOULD also return the serialized JSON in a TextContent
> block.

> If an output schema is provided: Servers **MUST** provide structured results
> that conform to this schema. Clients **SHOULD** validate structured results
> against this schema.

The live artifact itself is **out of scope** here — it is a separate project. This
ADR covers only the server-side contract it consumes.

## Decisions

### D1. All read tools return `structuredContent`, scoped to the success path

Every read tool gains a `structuredContent` payload alongside its existing text:
the five `reflect_*` tools, `get_budget_summary`, `get_category_details`,
`get_month`, `list_accounts`, `list_budgets`, `list_transactions`,
`search_payees`, and `triage_inbox`.

Each already has exactly one top-level compute object that its renderer consumes,
so this is a uniform one-line handler change (`text(render(x))` →
`result(render(x), x)`) — no tool needs a refactor to produce a structured value.

Scope was chosen as "all read tools" rather than just the two the artifact uses
today: the marginal cost per tool is one line, it future-proofs other
dashboards/consumers, and it keeps the analytics surface uniform rather than
special-casing two members of a family that all share the Compute/Render split.

### D2. The payload is the full compute object, passed through verbatim

`structuredContent` is the existing `compute*` return value as-is — no mapping or
curation layer. The handler stays `result(render(x), x)`.

This is deliberate: a mapping layer between the compute type and the wire shape
would reintroduce exactly the divergence risk this ADR exists to remove, and it
would break the single-source-of-truth property in D3. The few pre-formatted
display strings that ride along (`range.label` on `SpendingBreakdown`,
`truncationNote` on `SpendingTrends`) are harmless *additional* convenience
fields — a structured consumer can ignore them and use the raw `start`/`end`/
`months` that sit beside them. Internal-looking fields (`presentMonths`,
`parent_id`/`sub_id`, ids) are genuinely useful to consumers (sparklines,
drill-down links) and are kept.

### D3. `outputSchema` declared, with zod as the single source of truth

Each tool declares an `outputSchema`. To honor the spec's "Servers MUST provide
structured results that conform to this schema" without a second source of truth
drifting from the first, the result type is authored **in zod** and the
TypeScript interface is derived from it:

```ts
const SpendingBreakdownSchema = z.object({ /* range, totals, spending, ... */ });
export type SpendingBreakdown = z.infer<typeof SpendingBreakdownSchema>;
// ...in registerTool:
outputSchema: SpendingBreakdownSchema.shape,   // SDK takes a ZodRawShape, like inputSchema
```

This replaces the current hand-written `export interface SpendingBreakdown {…}`.
One definition feeds both the compile-time type (consumed by `compute*`/`render*`
and the tests) and the runtime `outputSchema`. The MCP TypeScript SDK validates
`structuredContent` against the declared schema and **throws** on mismatch, so a
hand-written zod schema sitting next to a hand-written interface would be a
foot-gun (silent until a field violates it in production); `z.infer` removes that
class of drift entirely.

Schemas are **co-located** in each tool file, replacing the existing interface —
consistent with the repo's file-per-tool architecture and "tool-local types live
in the tool file" rule. No central schema module (it would fight that
architecture and create a cross-cutting dependency the repo avoids).

Nullable fields (`largestOutflow`, `mostFrequent`, `stats`, `payee_name`, …) are
modeled `.nullable()` and optional ones (`sub_id`) `.optional()` so every emitted
payload conforms.

Rejected alternatives:

- **No `outputSchema` (match the write-tool precedent).** Cheaper — one-line
  handler change, zero schema maintenance — but the contract stays undiscoverable
  (`tools/list` doesn't expose the shape) and unvalidated. For a surface whose
  reason to exist is structured consumption, publishing and validating the
  contract is the payoff.
- **Hand-written zod schema alongside the existing hand-written interface.** Two
  sources of truth; drift surfaces as a runtime throw. `z.infer` is strictly
  better.

### D4. Money stays in milliunits; every money-bearing payload carries `iso`

`structuredContent` carries amounts in **milliunits**, matching the write-tool
`structuredContent` precedent (`before_budgeted`, `balance`, … are raw
milliunits) and keeping the payload a faithful echo of the compute object (which
holds milliunits throughout). Consumers divide by 1000. This is the unit
convention for *all* structured output; the human-readable dollar formatting
stays a render-only concern (`fmtMoney`).

Summed/raw amounts are integers; **averages are not** (`monthlyAvg`, `dailyAvg`,
`avgNet`, per-category `avg` are divisions). Those fields are typed `z.number()`,
not `z.number().int()`, so the "MUST conform" validation passes.

Every payload that contains money also carries an `iso` currency code
(`budget.currency_format?.iso_code ?? "USD"` — the expression `SpendingTrends`
already uses), so a consumer holding milliunits can format correctly without
assuming USD. `SpendingBreakdown` currently lacks `iso` and gains it; this also
fixes a latent non-USD bug in its text renderer, which hardcodes USD today.

### D5. `include_ids` stays a text-only knob; `structuredContent` always carries ids

`include_ids` controls only whether `— id <uuid>` suffixes appear in the rendered
**text**. The compute object always carries `id` fields, so `structuredContent`
is always fully addressable regardless of the flag. This is intended: the flag is
a text-verbosity control (keep prose clean for the model), whereas structured data
should always let a consumer build drill-down references. Noted in the `result()`
doc comment so it isn't "fixed" later by gating structured ids on the flag.

### D6. Error / guard branches stay text-only

Pre-compute guard returns — invalid range (`start_month > end_month`),
not-found (`Category <id> not found`), no month data in range — stay
`text(...)` with **no** `structuredContent`. There is no computed object at that
point, and these are informational/execution outcomes outside the success
contract; synthesizing a conforming-but-fake empty object would muddy "valid
empty result" vs "invalid request."

The resulting contract: **`structuredContent` present ⟺ a real computed result.**
A genuinely empty result (valid call, zero rows) still conforms naturally (empty
arrays, zeroed totals) because `compute*` *did* run. Consumers must fall back to
text on a missing `structuredContent`.

### D7. Text block stays human-readable (conscious deviation from the spec SHOULD)

The spec says a tool returning structured content SHOULD also return the
*serialized JSON* in the text block. We keep **human-readable** text there
instead, as the write tools already do: the text is what the model quotes to the
user; `structuredContent` is the machine copy. This deviation from a SHOULD (not a
MUST) is an established connector convention; consumers read `structuredContent`
first and fall back to text only on the D6 branches.

### D8. Tests: one-line schema-conformance assertion per tool

Each tool's existing compute test gains a single
`FooSchema.parse(computeOutput)` assertion on its fixture result. This is the
exact validation the SDK performs at call time, so any payload that would throw in
production (a stray `undefined`, a `NaN` from an unguarded divide) fails in CI
first. The `z.infer` link already prevents compile-time type/schema drift; this
covers the runtime gap the compiler can't see. No separate schema-test files and
no JSON snapshots — snapshots would churn on every legitimate field addition and
add noise without catching anything the parse assertion misses. Render tests stay
as substring assertions.

## Consequences

### Positive

- **Consumers drop the parsing layer.** A structured client reads fields by key
  (exact milliunits, no regex, no emoji-stripping, no dollar-in-name bug).
- **The contract is discoverable and validated.** `outputSchema` appears in
  `tools/list`; the SDK validates every payload against it.
- **Drift-proof and cheap.** `z.infer` single-source plus the pass-through handler
  make each tool a one-line change with no second source to maintain. Closes the
  `outputSchema` deferral ADR 0001 D8 left open.
- **Latent non-USD fix.** Adding `iso` to `SpendingBreakdown` corrects its
  hardcoded-USD text rendering as a side effect.

### Negative / risks

- **Wire contract now couples to the compute object shape.** Renaming a compute
  field is now a breaking change for consumers, not just an internal rename. This
  is the intended trade — a stable published contract — but it removes the freedom
  to reshape compute results silently.
- **Display strings leak into the structured contract** (`range.label`,
  `truncationNote`). Accepted as harmless additive fields (D2); a future
  tool-local trim is possible without a mapping layer.
- **SDK validation throws on mismatch.** A compute result that violates its schema
  fails the call in production rather than degrading. Mitigated by the D8
  per-tool parse assertion, but only as well as the fixtures cover.

### Implementation notes (not decisions)

- `search-payees.ts` has a local variable literally named `result`, which collides
  with the `result()` helper import — rename the local when wiring it.
- The handler change is `text(render(x))` → `result(render(x), x)`; `result()`
  itself is unchanged (it already attaches `structuredContent`).
- Deploy required: the live artifact and any remote consumer read the **deployed**
  Worker, so `npm run deploy` is needed for the new payloads to take effect —
  local-only changes won't reach Cowork.

### Future work explicitly deferred

- `outputSchema` on the **write** tools' `structuredContent` (ADR 0001 D8) — out
  of scope here; this ADR covers the read surface only.
- The live artifact's migration to prefer `structuredContent` with a text
  fallback — a separate project, not this repo.
