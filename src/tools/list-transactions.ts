import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Transaction, YnabClient } from "../ynab";
import { result, handleError, fmtTxLine } from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see docs/internals/structured-output.md).
// Money (`amount`) is in milliunits; cleared status and flag color are YNAB
// enum-ish strings left as plain strings.

const SubTransactionSchema = z.object({
  id: z.string(),
  transaction_id: z.string(),
  amount: z.number(),
  memo: z.string().nullable(),
  payee_id: z.string().nullable(),
  payee_name: z.string().nullable(),
  category_id: z.string().nullable(),
  category_name: z.string().nullable(),
});

const TransactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  memo: z.string().nullable(),
  cleared: z.string(),
  approved: z.boolean(),
  account_id: z.string(),
  account_name: z.string(),
  payee_id: z.string().nullable(),
  payee_name: z.string().nullable(),
  category_id: z.string().nullable(),
  category_name: z.string().nullable(),
  flag_color: z.string().nullable(),
  transfer_account_id: z.string().nullable(),
  deleted: z.boolean().optional(),
  subtransactions: z.array(SubTransactionSchema).optional(),
});

export const TransactionListSchema = z.object({
  // Currency code (e.g. "USD") for formatting the milliunit amounts below.
  iso: z.string(),
  // Most recent first (slice(-limit) then reversed).
  transactions: z.array(TransactionSchema),
});
export type TransactionList = z.infer<typeof TransactionListSchema>;

// ---- Compute (pure)

export interface ComputeOpts {
  limit: number;
  // Currency code for the structured payload. Optional for callers (tests)
  // that don't care; the handler always passes the plan's real code.
  iso?: string;
}

export const computeTransactionList = (
  fetched: Transaction[],
  opts: ComputeOpts,
): TransactionList => {
  return {
    iso: opts.iso ?? "USD",
    transactions: fetched.slice(-opts.limit).reverse(),
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

export const renderTransactionList = (
  list: TransactionList,
  opts: RenderOpts,
): string => {
  if (!list.transactions.length) return "No transactions match.";
  return list.transactions
    .map((t) => fmtTxLine(t, { includeIds: opts.includeIds, iso: list.iso }))
    .join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "List transactions in a plan, most recent first. Optionally bound the date " +
  "range with since_date and/or until_date (YYYY-MM-DD, inclusive) and filter " +
  "by type ('uncategorized' or 'unapproved'). Without since_date, searches " +
  "the plan's full history.";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" });

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
        since_date: isoDate.optional(),
        until_date: isoDate.optional(),
        type: z.enum(["uncategorized", "unapproved"]).optional(),
        limit: z.number().int().positive().max(500).optional().default(100),
        include_ids: z.boolean().optional().default(false),
      },
      outputSchema: TransactionListSchema.shape,
    },
    async ({ plan_id, since_date, until_date, type, limit, include_ids }) => {
      try {
        const c = getClient();
        const [{ data }, settingsRes] = await Promise.all([
          c.listTransactions(plan_id, {
            sinceDate: since_date,
            untilDate: until_date,
            type,
          }),
          c.getPlanSettings(plan_id),
        ]);
        const iso =
          settingsRes.data.settings.currency_format?.iso_code ?? "USD";
        const list = computeTransactionList(data.transactions, { limit, iso });
        return result(
          renderTransactionList(list, { includeIds: include_ids }),
          list,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
