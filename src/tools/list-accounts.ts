import { z } from "zod";
import { includeIdsParam, planIdParam } from "../schemas";
import { AccountSchema } from "../wire";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Account, YnabClient } from "../ynab";
import { result, handleError, fmtMoney } from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see docs/internals/structured-output.md).
// Money is in milliunits; balances carry no currency code, so we attach an
// iso field for formatting.

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
  // that don't care; the handler always passes the plan's real code.
  iso?: string;
}

export const computeAccountList = (
  fetched: Account[],
  opts: ComputeOpts,
): AccountList => {
  return {
    iso: opts.iso ?? "USD",
    accounts: fetched.filter(
      (a) => !a.deleted && (opts.includeClosed || !a.closed),
    ),
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

const DESCRIPTION =
  "List a plan's accounts with balance, cleared and uncleared balances, " +
  "bank-link health, and last reconciliation. Tracking (off-budget) " +
  "accounts are marked. Closed accounts are hidden unless include_closed.";

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
        plan_id: planIdParam,
        include_closed: z.boolean().optional().default(false),
        include_ids: includeIdsParam,
      },
      outputSchema: AccountListSchema.shape,
    },
    async ({ plan_id, include_closed, include_ids }) => {
      try {
        const c = getClient();
        const [{ data }, iso] = await Promise.all([
          c.listAccounts(plan_id),
          c.planIso(plan_id),
        ]);
        const list = computeAccountList(data.accounts, {
          includeClosed: include_closed,
          iso,
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
