import { z } from "zod";
import {
  dateParam,
  includeIdsParam,
  monthParam,
  planIdParam,
} from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Transaction, YnabClient } from "../ynab";
import { TransactionSchema } from "../wire";
import { result, handleError, fmtMoney, fmtTxLine, text } from "../format";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

export const TransactionListSchema = z.object({
  iso: z.string(),
  // Totals cover every matching transaction, not just the listed ones.
  count: z.number().int(),
  total: z.number().int(),
  // Net amount per month ("YYYY-MM-01"), chronological.
  by_month: z.array(
    z.object({
      month: z.string(),
      count: z.number().int(),
      total: z.number().int(),
    }),
  ),
  // Most recent first, capped at `limit`.
  transactions: z.array(TransactionSchema),
});
export type TransactionList = z.infer<typeof TransactionListSchema>;

// ---- Compute (pure)

export const computeTransactionList = (
  fetched: Transaction[],
  opts: { limit: number; iso: string },
): TransactionList => {
  const byMonth = new Map<string, { count: number; total: number }>();
  let total = 0;
  for (const t of fetched) {
    total += t.amount;
    const key = `${t.date.slice(0, 7)}-01`;
    const m = byMonth.get(key) ?? { count: 0, total: 0 };
    m.count += 1;
    m.total += t.amount;
    byMonth.set(key, m);
  }
  const sorted = [...fetched].sort((a, b) => b.date.localeCompare(a.date));
  return {
    iso: opts.iso,
    count: fetched.length,
    total,
    by_month: [...byMonth]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({ month, ...m })),
    transactions: sorted.slice(0, opts.limit),
  };
};

// ---- Render (pure)

export const renderTransactionList = (
  list: TransactionList,
  opts: { includeIds: boolean },
): string => {
  if (!list.count) return "No transactions match.";
  const { iso } = list;
  const out = [
    `${list.count} transactions, total ${fmtMoney(list.total, iso)}`,
  ];
  if (list.by_month.length > 1) {
    out.push("", "## By month");
    for (const m of list.by_month) {
      out.push(`- ${m.month.slice(0, 7)}: ${fmtMoney(m.total, iso)} (${m.count})`);
    }
  }
  out.push(
    "",
    list.transactions.length < list.count
      ? `## Most recent ${list.transactions.length} of ${list.count}`
      : "## Transactions",
  );
  for (const t of list.transactions) {
    out.push(fmtTxLine(t, iso, { includeIds: opts.includeIds }));
  }
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Transactions in a plan, most recent first, with the count, net total, and " +
  "per-month totals of every match. Narrow to one account_id, category_id, " +
  "payee_id, or month (at most one), bound dates with since_date and " +
  "until_date (YYYY-MM-DD, inclusive), and filter by type. Without " +
  "since_date it searches the plan's full history. By category, split " +
  "transactions appear as their parts in that category; by payee, as whole " +
  "transactions. Look up payee ids with list_payees. YNAB's API omits " +
  "pending bank transactions until they post. Amounts are signed: outflows " +
  "are negative.";

export const registerListTransactions = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_transactions",
    {
      title: "List Transactions",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        account_id: z.string().optional(),
        category_id: z.string().optional(),
        payee_id: z.string().optional(),
        month: monthParam.optional(),
        since_date: dateParam.optional(),
        until_date: dateParam.optional(),
        type: z.enum(["uncategorized", "unapproved"]).optional(),
        limit: z.number().int().positive().max(500).optional().default(100),
        include_ids: includeIdsParam,
      },
      outputSchema: TransactionListSchema.shape,
    },
    async (args) => {
      const scopes = [
        args.account_id,
        args.category_id,
        args.payee_id,
        args.month,
      ].filter((s) => s !== undefined);
      if (scopes.length > 1) {
        return {
          ...text(
            "Pass at most one of account_id, category_id, payee_id, or month.",
          ),
          isError: true as const,
        };
      }
      try {
        const c = getClient();
        const [{ data }, iso] = await Promise.all([
          c.listTransactions(args.plan_id, {
            accountId: args.account_id,
            categoryId: args.category_id,
            payeeId: args.payee_id,
            month: args.month,
            sinceDate: args.since_date,
            untilDate: args.until_date,
            type: args.type,
          }),
          c.planIso(args.plan_id),
        ]);
        const list = computeTransactionList(data.transactions, {
          limit: args.limit,
          iso,
        });
        return result(
          renderTransactionList(list, { includeIds: args.include_ids }),
          list,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
