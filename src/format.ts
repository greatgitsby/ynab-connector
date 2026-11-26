import { YnabError, fromMilli, type Category, type Transaction } from "./ynab";
import { fmtGoalSuffix } from "./goals";

export const text = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
});

export const result = <S>(s: string, structured: S) => ({
  content: [{ type: "text" as const, text: s }],
  structuredContent: structured,
});

export const errorMessage = (e: unknown): string =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

export const handleError = (e: unknown) => {
  const message =
    e instanceof YnabError
      ? `YNAB error ${e.status}: ${e.body}`
      : `Error: ${errorMessage(e)}`;
  return { ...text(message), isError: true as const };
};

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

export const fmtTxLine = (
  t: Transaction,
  iso: string,
  opts: { showCategory?: boolean; includeIds?: boolean } = {},
): string => {
  const showCategory = opts.showCategory ?? true;
  const payee = t.payee_name ?? "(no payee)";
  const cat = showCategory ? ` → ${t.category_name ?? "(uncategorized)"}` : "";
  const parts = t.subtransactions?.filter((s) => !s.deleted).length ?? 0;
  const split =
    t.type === "subtransaction"
      ? ` (split of ${t.parent_transaction_id})`
      : parts
        ? ` (${parts}-way split)`
        : "";
  const approval = t.approved ? "" : " (unapproved)";
  const idSuffix = opts.includeIds ? ` — id ${t.id}` : "";
  return `- ${t.date} ${fmtMoney(t.amount, iso)} ${payee}${cat}${split} [${t.account_name}]${approval}${idSuffix}`;
};

export const fmtSplitLines = (
  t: Transaction,
  iso: string,
  opts: { includeIds?: boolean } = {},
): string[] =>
  (t.subtransactions ?? [])
    .filter((s) => !s.deleted)
    .map((s) => {
      const payee = s.payee_name ? ` ${s.payee_name}` : "";
      const memo = s.memo ? ` "${s.memo}"` : "";
      const idSuffix = opts.includeIds ? ` — id ${s.id}` : "";
      return `  - ${fmtMoney(s.amount, iso)}${payee} → ${s.category_name ?? "(uncategorized)"}${memo}${idSuffix}`;
    });
