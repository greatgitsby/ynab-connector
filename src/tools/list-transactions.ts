import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transaction, YnabClient } from "../ynab";
import { text, handleError, fmtTxLine } from "../format";

// ---- Result types

export interface TransactionList {
  // Most recent first (slice(-limit) then reversed).
  transactions: Transaction[];
}

// ---- Compute (pure)

export interface ComputeOpts {
  limit: number;
}

export const computeTransactionList = (
  fetched: Transaction[],
  opts: ComputeOpts,
): TransactionList => {
  return { transactions: fetched.slice(-opts.limit).reverse() };
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
    .map((t) => fmtTxLine(t, { includeIds: opts.includeIds }))
    .join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "List transactions in a budget. Optionally filter by since_date (YYYY-MM-DD) and/or type ('uncategorized' or 'unapproved').";

export const registerListTransactions = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_transactions",
    {
      description: DESCRIPTION,
      inputSchema: {
        budget_id: z.string(),
        since_date: z.string().optional(),
        type: z.enum(["uncategorized", "unapproved"]).optional(),
        limit: z.number().int().positive().max(500).optional().default(100),
        include_ids: z.boolean().optional().default(false),
      },
    },
    async ({ budget_id, since_date, type, limit, include_ids }) => {
      try {
        const { data } = await getClient().listTransactions(budget_id, {
          sinceDate: since_date,
          type,
        });
        const list = computeTransactionList(data.transactions, { limit });
        return text(renderTransactionList(list, { includeIds: include_ids }));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
