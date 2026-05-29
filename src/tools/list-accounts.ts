import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Account, YnabClient } from "../ynab";
import { text, handleError, fmtMoney } from "../format";

// ---- Result type

export interface AccountList {
  accounts: Account[];
}

// ---- Compute (pure)

export interface ComputeOpts {
  includeClosed: boolean;
}

export const computeAccountList = (
  fetched: Account[],
  opts: ComputeOpts,
): AccountList => {
  return {
    accounts: fetched.filter((a) => opts.includeClosed || !a.closed),
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

const fmtAccountLine = (a: Account, includeIds: boolean): string => {
  const idSuffix = includeIds ? ` — id ${a.id}` : "";
  // Link health: YNAB exposes whether an account is linked for direct import
  // and whether that link is broken (it does NOT expose the bank's balance).
  const link = a.direct_import_in_error
    ? ", linked ⚠ (connection error)"
    : a.direct_import_linked
      ? ", linked ✓"
      : "";
  const lastRecon = a.last_reconciled_at
    ? `, last reconciled ${a.last_reconciled_at.slice(0, 10)}`
    : "";
  return `- ${a.name} [${a.type}] ${a.on_budget ? "(on-budget)" : "(off-budget)"}${a.closed ? " (closed)" : ""}: balance ${fmtMoney(a.balance)}, cleared ${fmtMoney(a.cleared_balance)}, uncleared ${fmtMoney(a.uncleared_balance)}${link}${lastRecon}${idSuffix}`;
};

export const renderAccountList = (
  list: AccountList,
  opts: RenderOpts,
): string => {
  if (!list.accounts.length) return "No accounts.";
  return list.accounts
    .map((a) => fmtAccountLine(a, opts.includeIds))
    .join("\n");
};

// ---- MCP tool registration

const DESCRIPTION = "List all accounts in a budget with balances.";

export const registerListAccounts = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        budget_id: z.string(),
        include_closed: z.boolean().optional().default(false),
        include_ids: z.boolean().optional().default(false),
      },
    },
    async ({ budget_id, include_closed, include_ids }) => {
      try {
        const { data } = await getClient().listAccounts(budget_id);
        const list = computeAccountList(data.accounts, {
          includeClosed: include_closed,
        });
        return text(renderAccountList(list, { includeIds: include_ids }));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
