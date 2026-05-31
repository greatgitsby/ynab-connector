import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Account, YnabClient } from "../ynab";
import { result, handleError, fmtMoney } from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see ADR 0002).
// Money is in milliunits; balances carry no currency code, so we attach an
// iso field for formatting.

const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  on_budget: z.boolean(),
  closed: z.boolean(),
  deleted: z.boolean().optional(),
  balance: z.number(),
  cleared_balance: z.number(),
  uncleared_balance: z.number(),
  // Direct-import (linked-bank) status. Absent on accounts that predate the
  // field or were never linked. Note: YNAB's API does NOT expose the bank's
  // reported balance — only these health flags and the last-reconciled time.
  direct_import_linked: z.boolean().optional(),
  direct_import_in_error: z.boolean().optional(),
  last_reconciled_at: z.string().nullable().optional(),
});

export const AccountListSchema = z.object({
  // Currency code (e.g. "USD") for formatting the milliunit balances below.
  iso: z.string(),
  accounts: z.array(AccountSchema),
});
export type AccountList = z.infer<typeof AccountListSchema>;

// ---- Compute (pure)

export interface ComputeOpts {
  includeClosed: boolean;
  // Currency code for the structured payload. Optional for callers (tests)
  // that don't care; the handler always passes the budget's real code.
  iso?: string;
}

export const computeAccountList = (
  fetched: Account[],
  opts: ComputeOpts,
): AccountList => {
  return {
    iso: opts.iso ?? "USD",
    accounts: fetched.filter((a) => opts.includeClosed || !a.closed),
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

const fmtAccountLine = (
  a: AccountList["accounts"][number],
  iso: string,
  includeIds: boolean,
): string => {
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
  return `- ${a.name} [${a.type}] ${a.on_budget ? "(on-budget)" : "(off-budget)"}${a.closed ? " (closed)" : ""}: balance ${fmtMoney(a.balance, iso)}, cleared ${fmtMoney(a.cleared_balance, iso)}, uncleared ${fmtMoney(a.uncleared_balance, iso)}${link}${lastRecon}${idSuffix}`;
};

export const renderAccountList = (
  list: AccountList,
  opts: RenderOpts,
): string => {
  if (!list.accounts.length) return "No accounts.";
  return list.accounts
    .map((a) => fmtAccountLine(a, list.iso, opts.includeIds))
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
      outputSchema: AccountListSchema.shape,
    },
    async ({ budget_id, include_closed, include_ids }) => {
      try {
        const { data } = await getClient().listAccounts(budget_id);
        const list = computeAccountList(data.accounts, {
          includeClosed: include_closed,
        });
        return result(
          renderAccountList(list, { includeIds: include_ids }),
          list,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
