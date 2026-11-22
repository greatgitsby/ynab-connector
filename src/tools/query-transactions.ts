import { z } from "zod";
import { dateParam, includeIdsParam, monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { YnabClient } from "../ynab";
import { fmtMoney, handleError, result, text } from "../format";
import {
  DEFAULT_ROW_FIELDS,
  RowSchema,
  fmtRowLine,
  flattenTransactions,
  median,
  pickRow,
  rowFieldsParam,
  todayIso,
  type FlatRow,
  type RowField,
} from "../rows";
import {
  accountRefs,
  categoryRefs,
  isUuid,
  normalizeName,
  payeeRefs,
  resolveAll,
  type Named,
} from "../resolve";
import { isCardPaymentPayee } from "../predicates";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const GROUP_BY = ["payee", "category", "month", "account"] as const;
type GroupBy = (typeof GROUP_BY)[number];

const RefSchema = z.object({ id: z.string(), name: z.string() });

const GroupSchema = z.object({
  // The payee, category, or account id, or "YYYY-MM-01". "none" for rows
  // with no payee or category.
  key: z.string(),
  name: z.string(),
  count: z.number().int(),
  total: z.number().int(),
  // Median amount, the usual size of one charge.
  typical_amount: z.number().int(),
  min_amount: z.number().int(),
  max_amount: z.number().int(),
  first_date: z.string(),
  last_date: z.string(),
});
export type Group = z.infer<typeof GroupSchema>;

export const QueryResultSchema = z.object({
  iso: z.string(),
  // Over every matching row, not just this page.
  count: z.number().int(),
  total: z.number().int(),
  inflow: z.number().int(),
  outflow: z.number().int(),
  // What each name filter matched, so a loose name can be checked.
  matched: z.object({
    accounts: z.array(RefSchema).optional(),
    categories: z.array(RefSchema).optional(),
    payees: z.array(RefSchema).optional(),
  }),
  group_by: z.enum(GROUP_BY).nullable(),
  group_count: z.number().int(),
  groups: z.array(GroupSchema),
  // Most recent first, from `offset`.
  offset: z.number().int(),
  next_offset: z.number().int().nullable(),
  rows: z.array(RowSchema),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

// ---- Compute (pure)

export interface RowFilter {
  accountIds?: ReadonlySet<string>;
  categoryIds?: ReadonlySet<string>;
  payeeIds?: ReadonlySet<string>;
  search?: string | string[];
  excludeTransfers?: boolean;
  direction?: "outflow" | "inflow";
}

// Any term matches. Each term is split on " OR " too, and a term with " AND "
// needs every part. Otherwise a term is a literal substring.
const searchTerms = (search: string | string[] | undefined): string[][] =>
  [search ?? []]
    .flat()
    .flatMap((t) => t.split(/\s+OR\s+/))
    .map((t) => t.split(/\s+AND\s+/).map(normalizeName).filter(Boolean))
    .filter((t) => t.length);

export const filterRows = (rows: FlatRow[], f: RowFilter): FlatRow[] => {
  const terms = searchTerms(f.search);
  return rows.filter((r) => {
    if (f.accountIds && !f.accountIds.has(r.account_id)) return false;
    if (f.categoryIds && !(r.category_id && f.categoryIds.has(r.category_id))) return false;
    if (f.payeeIds && !(r.payee_id && f.payeeIds.has(r.payee_id))) return false;
    if (f.excludeTransfers && (r.transfer || isCardPaymentPayee(r.payee))) return false;
    if (f.direction === "outflow" && r.amount >= 0) return false;
    if (f.direction === "inflow" && r.amount <= 0) return false;
    if (terms.length) {
      const hay = normalizeName(`${r.payee ?? ""} ${r.memo ?? ""}`);
      if (!terms.some((t) => t.every((part) => hay.includes(part)))) return false;
    }
    return true;
  });
};

const groupKey = (r: FlatRow, by: GroupBy): [string, string] => {
  switch (by) {
    case "payee":
      return [r.payee_id ?? "none", r.payee ?? "(no payee)"];
    case "category":
      return [r.category_id ?? "none", r.category ?? "(uncategorized)"];
    case "account":
      return [r.account_id, r.account];
    case "month":
      return [`${r.date.slice(0, 7)}-01`, r.date.slice(0, 7)];
  }
};

export const groupRows = (rows: FlatRow[], by: GroupBy): Group[] => {
  const acc = new Map<string, { name: string; rows: FlatRow[] }>();
  for (const r of rows) {
    const [key, name] = groupKey(r, by);
    const g = acc.get(key) ?? { name, rows: [] };
    g.rows.push(r);
    acc.set(key, g);
  }
  const groups = [...acc].map(([key, g]): Group => {
    const amounts = g.rows.map((r) => r.amount);
    const dates = g.rows.map((r) => r.date).sort();
    return {
      key,
      name: g.name,
      count: g.rows.length,
      total: amounts.reduce((a, b) => a + b, 0),
      typical_amount: median(amounts),
      min_amount: Math.min(...amounts),
      max_amount: Math.max(...amounts),
      first_date: dates[0],
      last_date: dates[dates.length - 1],
    };
  });
  return by === "month"
    ? groups.sort((a, b) => a.key.localeCompare(b.key))
    : groups.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
};

export interface QueryOpts {
  iso: string;
  groupBy?: GroupBy;
  groupLimit: number;
  limit: number;
  offset: number;
  fields: readonly RowField[];
  matched?: QueryResult["matched"];
}

export const sortRows = (rows: FlatRow[]): FlatRow[] =>
  [...rows].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

// `sorted` comes from sortRows, so the page and the render agree.
export const computeQuery = (sorted: FlatRow[], opts: QueryOpts): QueryResult => {
  let inflow = 0;
  let outflow = 0;
  for (const r of sorted) {
    if (r.amount > 0) inflow += r.amount;
    else outflow += r.amount;
  }
  const groups = opts.groupBy ? groupRows(sorted, opts.groupBy) : [];
  const page = sorted.slice(opts.offset, opts.offset + opts.limit);
  const end = opts.offset + page.length;
  return {
    iso: opts.iso,
    count: sorted.length,
    total: inflow + outflow,
    inflow,
    outflow,
    matched: opts.matched ?? {},
    group_by: opts.groupBy ?? null,
    group_count: groups.length,
    groups: groups.slice(0, opts.groupLimit),
    offset: opts.offset,
    next_offset: opts.limit > 0 && end < sorted.length ? end : null,
    rows: page.map((r) => pickRow(r, opts.fields)),
  };
};

// ---- Render (pure)

export const renderQuery = (
  q: QueryResult,
  pageRows: FlatRow[],
  opts: { includeIds: boolean },
): string => {
  if (!q.count) return "No transactions match.";
  const { iso } = q;
  const out = [
    `${q.count} rows, net ${fmtMoney(q.total, iso)} (in ${fmtMoney(q.inflow, iso)}, out ${fmtMoney(q.outflow, iso)})`,
  ];
  for (const [kind, refs] of Object.entries(q.matched)) {
    if (refs?.length) out.push(`Matched ${kind}: ${refs.map((r) => r.name).join(", ")}`);
  }
  if (q.group_by) {
    const shown = q.groups.length < q.group_count ? ` (top ${q.groups.length} of ${q.group_count})` : ` (${q.group_count})`;
    out.push("", `## By ${q.group_by}${shown}`);
    for (const g of q.groups) {
      const span = g.first_date === g.last_date ? g.first_date : `${g.first_date} to ${g.last_date}`;
      const id = opts.includeIds && q.group_by !== "month" ? ` — id ${g.key}` : "";
      out.push(
        `- ${g.name}: ${fmtMoney(g.total, iso)} over ${g.count}, typical ${fmtMoney(g.typical_amount, iso)}, ${span}${id}`,
      );
    }
  }
  if (pageRows.length) {
    const from = q.offset + 1;
    const to = q.offset + pageRows.length;
    out.push("", `## Rows ${from}–${to} of ${q.count}, newest first`);
    for (const r of pageRows) out.push(fmtRowLine(r, iso, opts.includeIds));
    if (q.next_offset != null) out.push(`(more: pass offset ${q.next_offset})`);
  }
  return out.join("\n");
};

// ---- MCP tool registration

const monthEnd = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// Names become ids here. Uuids pass through without a lookup.
const resolveRefs = (
  refs: string[] | undefined,
  items: Named[] | null,
  kind: string,
): { ids?: Set<string>; matched?: { id: string; name: string }[]; error?: string } => {
  if (!refs?.length) return {};
  const ids = new Set<string>();
  const matched: { id: string; name: string }[] = [];
  for (const ref of refs) {
    const r = items ? resolveAll(items, ref, kind) : null;
    if (r?.ok) {
      for (const m of r.matches) {
        if (!ids.has(m.id)) matched.push({ id: m.id, name: m.name });
        ids.add(m.id);
      }
    } else if (isUuid(ref)) {
      ids.add(ref.trim());
    } else {
      return { error: r ? r.error : `No ${kind} matches "${ref}".` };
    }
  }
  return { ids, matched };
};

const DESCRIPTION =
  "Search and summarize transactions in one call, with compact rows (date, amount, payee, category, account, memo, id). " +
  "Each split part is its own row with its own category, so category totals are exact; `id` is always the transaction id update_transactions takes. " +
  "Filter by any number of accounts, categories, and payees (names or ids; a name matches case- and emoji-insensitively, and every payee or category with that name counts), " +
  "text `search` over payee and memo (a substring; several terms as an array or joined with OR match any, AND needs all), dates, direction, and type. Filters of one kind are OR'd, different kinds AND'd. " +
  "group_by payee, category, month, or account returns per-group count, total, typical (median) amount, min, max, and first and last date. " +
  "Rows come newest first, `limit` per page (default 100, or 0 when grouping), paged with `offset`/`next_offset`; totals and groups always cover every match. " +
  "exclude_transfers also drops credit card payments recorded as spending (payees like \"Apple Card Payment\" or \"Autopay\"). " +
  "Without dates it searches all history. Pick `fields` to shrink rows; choosing `id` shows ids in the text too. Amounts are milliunits, outflows negative. Pending bank transactions are not in YNAB's API.";

export const registerQueryTransactions = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "query_transactions",
    {
      title: "Query Transactions",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        accounts: z.array(z.string()).optional().describe("Account names or ids."),
        categories: z.array(z.string()).optional().describe('Category names, "Group: Name", or ids.'),
        payees: z.array(z.string()).optional().describe("Payee names or ids."),
        search: z
          .union([z.string(), z.array(z.string()).min(1)])
          .optional()
          .describe('Text in the payee name or memo, case-insensitive. Several terms match any: ["Anthropic", "Claude"] or "Anthropic OR Claude". "a AND b" needs both.'),
        month: monthParam.optional().describe("One month; replaces since_date/until_date."),
        since_date: dateParam.optional(),
        until_date: dateParam.optional(),
        type: z.enum(["uncategorized", "unapproved"]).optional(),
        direction: z.enum(["outflow", "inflow"]).optional(),
        exclude_transfers: z.boolean().optional().default(false),
        group_by: z.enum(GROUP_BY).optional(),
        group_limit: z.number().int().min(1).max(1000).optional().default(100),
        limit: z.number().int().min(0).max(1000).optional(),
        offset: z.number().int().min(0).optional().default(0),
        fields: rowFieldsParam,
        include_ids: includeIdsParam,
      },
      outputSchema: QueryResultSchema.shape,
    },
    async (args) => {
      if (args.month && (args.since_date || args.until_date)) {
        return {
          ...text("Pass month or since_date/until_date, not both."),
          isError: true as const,
        };
      }
      try {
        const c = getClient();
        const needs = (refs?: string[]) => !!refs?.some((r) => !isUuid(r));
        const [cats, payees, accounts, iso] = await Promise.all([
          needs(args.categories) ? c.listCategories(args.plan_id) : null,
          needs(args.payees) ? c.listPayees(args.plan_id) : null,
          needs(args.accounts) ? c.listAccounts(args.plan_id) : null,
          c.planIso(args.plan_id),
        ]);
        const acc = resolveRefs(args.accounts, accounts && accountRefs(accounts.data.accounts), "account");
        const cat = resolveRefs(args.categories, cats && categoryRefs(cats.data.category_groups), "category");
        const pay = resolveRefs(args.payees, payees && payeeRefs(payees.data.payees), "payee");
        const err = acc.error ?? cat.error ?? pay.error;
        if (err) return { ...text(err), isError: true as const };

        const month = args.month === "current" ? `${todayIso().slice(0, 7)}-01` : args.month;
        const sinceDate = month ?? args.since_date;
        const untilDate = month ? monthEnd(month) : args.until_date;
        const oneAccount = acc.ids?.size === 1 ? [...acc.ids][0] : undefined;
        const { data } = await c.listTransactions(args.plan_id, {
          accountId: oneAccount,
          sinceDate,
          untilDate,
          type: args.type,
        });
        const rows = sortRows(filterRows(flattenTransactions(data.transactions), {
          accountIds: acc.ids,
          categoryIds: cat.ids,
          payeeIds: pay.ids,
          search: args.search,
          excludeTransfers: args.exclude_transfers,
          direction: args.direction,
        }));
        const limit = args.limit ?? (args.group_by ? 0 : 100);
        const fields = args.fields ?? DEFAULT_ROW_FIELDS;
        const q = computeQuery(rows, {
          iso,
          groupBy: args.group_by,
          groupLimit: args.group_limit,
          limit,
          offset: args.offset,
          fields,
          matched: {
            ...(acc.matched?.length ? { accounts: acc.matched } : {}),
            ...(cat.matched?.length ? { categories: cat.matched } : {}),
            ...(pay.matched?.length ? { payees: pay.matched } : {}),
          },
        });
        const pageRows = rows.slice(args.offset, args.offset + limit);
        const includeIds = args.include_ids || !!args.fields?.includes("id");
        return result(renderQuery(q, pageRows, { includeIds }), q);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
