import { YnabError, fromMilli, type Category, type Transaction } from "./ynab";
import { fmtGoalSuffix } from "./goals";

export const text = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
});

// Attaches a `structuredContent` field alongside the text content. Per MCP
// 2025-11-25, tools return both human-readable text (for the model to quote
// to the user) and machine-readable JSON (for the model — or a live artifact
// — to keep working without re-parsing the prose). Read tools also declare an
// `outputSchema` so the payload is discoverable and validated; see ADR 0002.
//
// Conventions for the structured payload (ADR 0002):
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

export const handleError = (e: unknown) => {
  if (e instanceof YnabError) return text(`YNAB error ${e.status}: ${e.body}`);
  return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
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
        "access. To enable budget edits, disconnect and reconnect the YNAB " +
        "connector in Claude.ai's settings — accept the broader permission " +
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
  includeIds = false,
): string => {
  const idSuffix = includeIds ? ` — id ${c.id}` : "";
  return `- ${c.name}: budgeted ${fmtMoney(c.budgeted)}, activity ${fmtMoney(c.activity)}, balance ${fmtMoney(c.balance)}${fmtGoalSuffix(c, refMonth)}${idSuffix}`;
};

export const fmtTxLine = (
  t: Transaction,
  opts: { showCategory?: boolean; includeIds?: boolean; iso?: string } = {},
): string => {
  const showCategory = opts.showCategory ?? true;
  const payee = t.payee_name ?? "(no payee)";
  const cat = showCategory
    ? ` → ${t.category_name ?? "(uncategorized)"}`
    : "";
  const approval = t.approved ? "" : " (unapproved)";
  const idSuffix = opts.includeIds ? ` — id ${t.id}` : "";
  return `- ${t.date} ${fmtMoney(t.amount, opts.iso)} ${payee}${cat} [${t.account_name}]${approval}${idSuffix}`;
};

// One row of activity expanded for a single Category. Used by
// fmtActivityLine and produced by tool-local expandForCategory helpers
// when drilling into a category's transactions.
export interface ActivityLineData {
  date: string;
  amount: number;
  payee_name: string | null;
  account_name: string;
  approved: boolean;
  parent_id: string;
  sub_id?: string;
  note?: string;
}

export const fmtActivityLine = (
  a: ActivityLineData,
  includeIds = false,
): string => {
  const payee = a.payee_name ?? "(no payee)";
  const approval = a.approved ? "" : " (unapproved)";
  const note = a.note ? ` (${a.note})` : "";
  const idSuffix = includeIds ? ` — id ${a.sub_id ?? a.parent_id}` : "";
  return `- ${a.date} ${fmtMoney(a.amount)} ${payee}${note} [${a.account_name}]${approval}${idSuffix}`;
};
