import { YnabError, fromMilli, type Category, type Transaction } from "./ynab";
import { fmtGoalSuffix } from "./goals";

export const text = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
});

// Attaches a `structuredContent` field alongside the text content. Per MCP
// 2025-11-25, tools return both human-readable text (for the model to quote
// to the user) and machine-readable JSON (for the model — or a live artifact
// — to keep working without re-parsing the prose). Read tools also declare an
// `outputSchema` so the payload is discoverable and validated; see
// docs/internals/structured-output.md.
//
// Conventions for the structured payload:
//  - Money is in raw milliunits (matching the YNAB wire + write tools), never
//    pre-divided dollars. A money-bearing payload also carries an `iso`
//    currency code so a consumer can format without assuming USD. Summed/raw
//    amounts are integers; averages are not, so they stay z.number().
//  - `structuredContent` always carries item ids regardless of any
//    `include_ids` flag — that flag is a text-verbosity knob only. Structured
//    data should always be fully addressable for drill-downs.
//  - Only the success path returns `structuredContent`; pre-compute guard
//    branches (not-found, invalid range) stay text-only. So a present
//    `structuredContent` means a real computed result.
export const result = <S>(s: string, structured: S) => ({
  content: [{ type: "text" as const, text: s }],
  structuredContent: structured as S,
});

// Tool execution error (isError: true), so the client and model can tell a
// failed call from a successful one that happens to contain prose.
export const handleError = (e: unknown) => {
  const message =
    e instanceof YnabError
      ? `YNAB error ${e.status}: ${e.body}`
      : `Error: ${e instanceof Error ? e.message : String(e)}`;
  return { ...text(message), isError: true as const };
};

// Returned by write tools when the active token wasn't issued with write
// scope. Spec-compliant tool execution error (isError: true) — the model can
// paraphrase the message to ask the user to reconnect.
export const scopeDeniedError = () => ({
  content: [
    {
      type: "text" as const,
      text:
        "Write access denied: this YNAB connection was granted read-only " +
        "access. To allow plan edits, disconnect and reconnect the YNAB " +
        "connector in your MCP client, then accept the broader permission " +
        "scope on the YNAB authorization page.",
    },
  ],
  isError: true as const,
});

export const fmtMoney = (milli: number, iso = "USD"): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: iso }).format(
    fromMilli(milli),
  );

export const padMoney = (milli: number, width: number, iso = "USD"): string =>
  fmtMoney(milli, iso).padStart(width);

export const fmtPercent = (num: number, total: number): string =>
  total === 0 ? "0.0%" : `${((num / total) * 100).toFixed(1)}%`;

export function pushSection<T>(
  out: string[],
  title: string,
  items: T[],
  cap: number,
  render: (item: T) => string,
): void {
  const header =
    items.length <= cap
      ? `## ${title} (${items.length})`
      : `## ${title} (showing ${cap} of ${items.length})`;
  out.push(header);
  if (!items.length) {
    out.push("(none)");
  } else {
    for (const item of items.slice(0, cap)) out.push(render(item));
  }
  out.push("");
}

export const fmtCategoryLine = (
  c: Category,
  refMonth: string,
  iso: string,
  includeIds = false,
): string => {
  const idSuffix = includeIds ? ` — id ${c.id}` : "";
  return `- ${c.name}: budgeted ${fmtMoney(c.budgeted, iso)}, activity ${fmtMoney(c.activity, iso)}, balance ${fmtMoney(c.balance, iso)}${fmtGoalSuffix(c, refMonth, iso)}${idSuffix}`;
};

// One transaction line. Hybrid split rows (category and payee listings) are
// marked so the reader knows the amount is one part of a larger transaction.
export const fmtTxLine = (
  t: Transaction,
  iso: string,
  opts: { showCategory?: boolean; includeIds?: boolean } = {},
): string => {
  const showCategory = opts.showCategory ?? true;
  const payee = t.payee_name ?? "(no payee)";
  const cat = showCategory
    ? ` → ${t.category_name ?? "(uncategorized)"}`
    : "";
  const split =
    t.type === "subtransaction"
      ? ` (split of ${t.parent_transaction_id})`
      : t.subtransactions?.length
        ? ` (${t.subtransactions.length}-way split)`
        : "";
  const approval = t.approved ? "" : " (unapproved)";
  const idSuffix = opts.includeIds ? ` — id ${t.id}` : "";
  return `- ${t.date} ${fmtMoney(t.amount, iso)} ${payee}${cat}${split} [${t.account_name}]${approval}${idSuffix}`;
};
