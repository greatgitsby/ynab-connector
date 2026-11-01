# Structured output

Every read tool returns its compute result as `structuredContent` and declares it as
`outputSchema`. Consumers such as live dashboards read fields by key instead of regex-parsing
rendered text, which broke on every wording change.

## The contract

- **The payload is the compute object, verbatim.** Handlers return `result(render(x), x)`. A mapping
  layer would reintroduce the drift this exists to remove. Convenience strings that ride along
  (`range.label`, `truncationNote`) are harmless extras. Renaming a compute field is therefore a
  breaking wire change.
- **YNAB's shapes and names.** YNAB objects pass through verbatim, typed by the schemas in
  [`wire.ts`](../../src/wire.ts), which follow the spec's required fields so validation tolerates
  endpoints that omit the rest. They declare every field in the v1.88 spec, including the
`*_formatted` / `*_currency` money siblings, which tools pass through but never compute from. They
are also `z.looseObject`, so a field a later API version adds still passes validation. A strict
`z.object` emits `additionalProperties: false`, and the client rejects the call. Fields the connector adds use YNAB's snake_case.
- **Zod is the single source of truth.** Each tool file defines its result schema and derives the
  type with `z.infer`. The MCP SDK validates `structuredContent` against `outputSchema` and throws
  on mismatch, so a hand-written interface beside a schema is a production failure waiting to
  happen. Each compute test runs `Schema.parse` on its fixture result to catch `undefined` or
  `NaN` before the SDK does.
- **Money is milliunits.** Sums are integers; averages are not, so they stay `z.number()`. Every
  money-bearing payload carries an `iso` currency code so consumers never assume USD.
- **Ids are always present.** `include_ids` only controls the `— id <uuid>` text suffixes.
  Structured data stays fully addressable.
- **Present means computed.** Guard branches (not found, invalid range, no data) return text only.
  A valid empty result still conforms, because compute ran. Consumers fall back to text when
  `structuredContent` is missing.
- **Text stays human-readable.** MCP says the text block SHOULD repeat the JSON. We deviate on
  purpose: the text is what the model quotes to the user.

Write tools return `structuredContent` too, but without an `outputSchema`. See
[write tools](./write-tools.md#shape).
