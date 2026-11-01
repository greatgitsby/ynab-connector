import { z } from "zod";
import { dateParam, includeIdsParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ScheduledTransaction, YnabClient } from "../ynab";
import { ScheduledTransactionSchema } from "../wire";
import { result, handleError, fmtMoney } from "../format";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

export const ScheduledTransactionListSchema = z.object({
  iso: z.string(),
  // Soonest date_next first.
  scheduled_transactions: z.array(ScheduledTransactionSchema),
});
export type ScheduledTransactionList = z.infer<
  typeof ScheduledTransactionListSchema
>;

// ---- Compute (pure)

export const computeScheduledTransactionList = (
  fetched: ScheduledTransaction[],
  opts: { untilDate?: string; iso: string },
): ScheduledTransactionList => ({
  iso: opts.iso,
  scheduled_transactions: fetched
    .filter(
      (s) => !s.deleted && (!opts.untilDate || s.date_next <= opts.untilDate),
    )
    .sort((a, b) => a.date_next.localeCompare(b.date_next)),
});

// ---- Render (pure)

export const renderScheduledTransactionList = (
  list: ScheduledTransactionList,
  opts: { includeIds: boolean },
): string => {
  if (!list.scheduled_transactions.length) return "No scheduled transactions.";
  return list.scheduled_transactions
    .map((s) => {
      const repeat = s.frequency === "never" ? "once" : s.frequency;
      const category = s.transfer_account_id
        ? " (transfer)"
        : ` → ${s.category_name ?? "(uncategorized)"}`;
      const idSuffix = opts.includeIds ? ` — id ${s.id}` : "";
      return `- ${s.date_next} ${fmtMoney(s.amount, list.iso)} ${s.payee_name ?? "(no payee)"}${category} [${s.account_name}], ${repeat}${idSuffix}`;
    })
    .join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Scheduled transactions: upcoming bills, paychecks, and transfers that " +
  "YNAB will enter automatically on date_next and then repeat at " +
  "`frequency` (\"never\" means once). They are not yet in account balances " +
  "or category activity, so count them as money already spoken for. Soonest " +
  "first; pass until_date (YYYY-MM-DD) to stop at a date. Amounts are " +
  "signed: outflows are negative.";

export const registerListScheduledTransactions = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_scheduled_transactions",
    {
      title: "List Scheduled Transactions",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        until_date: dateParam.optional(),
        include_ids: includeIdsParam,
      },
      outputSchema: ScheduledTransactionListSchema.shape,
    },
    async ({ plan_id, until_date, include_ids }) => {
      try {
        const c = getClient();
        const [{ data }, iso] = await Promise.all([
          c.listScheduledTransactions(plan_id),
          c.planIso(plan_id),
        ]);
        const list = computeScheduledTransactionList(
          data.scheduled_transactions,
          { untilDate: until_date, iso },
        );
        return result(
          renderScheduledTransactionList(list, { includeIds: include_ids }),
          list,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
