import { McpServer } from "@modelcontextprotocol/server";
import { YnabClient } from "./ynab";
import type { Props } from "./ynab-auth";
import { registerListPlans } from "./tools/list-plans";
import { registerListAccounts } from "./tools/list-accounts";
import { registerListMonths } from "./tools/list-months";
import { registerGetMonth } from "./tools/get-month";
import { registerGetCategory } from "./tools/get-category";
import { registerListTransactions } from "./tools/list-transactions";
import { registerListScheduledTransactions } from "./tools/list-scheduled-transactions";
import { registerListMoneyMovements } from "./tools/list-money-movements";
import { registerListPayees } from "./tools/list-payees";
import { registerTriageInbox } from "./tools/triage-inbox";
import { registerReflectIncomeExpense } from "./tools/reflect-income-expense";
import { registerReflectNetWorth } from "./tools/reflect-net-worth";
import { registerAssignToCategories } from "./tools/assign-to-categories";
import { registerUpdateTransactions } from "./tools/update-transactions";
import { registerReconcileAccount } from "./tools/reconcile-account";
import { registerReviewPayees } from "./tools/review-payees";
import { registerRenamePayees } from "./tools/rename-payees";
import { registerMergePayees } from "./tools/merge-payees";

export const SERVER_VERSION = "0.4.0";

const INSTRUCTIONS =
  "YNAB (You Need A Budget) connector. Tools follow YNAB's API: list_* and get_* return YNAB objects with YNAB's field names, and reflect_* tools are multi-month reports. " +
  'Every plan-scoped tool takes an optional plan_id; it defaults to "last-used" (the most recently used plan), so call list_plans only when the user has several plans. ' +
  'Money in text is already formatted in the plan\'s currency; structured output and write tools use YNAB milliunits (1000 = 1.00), and outflows are negative. Months are "YYYY-MM-01" or "current"; dates are "YYYY-MM-DD". Add include_ids for "— id <uuid>" on each text line; structured output always carries ids. ' +
  "Start with triage_inbox for what needs attention, or get_month for this month's categories. list_scheduled_transactions shows upcoming bills and transfers that are not yet in balances. list_money_movements shows assignments and moves between categories, including money taken from savings goals. list_transactions narrows to an account, category, payee, or month over any date range and totals the matches; find payee ids with list_payees. review_payees finds duplicate and little-used payees. " +
  "Write tools (assign_to_categories, update_transactions, reconcile_account, rename_payees, merge_payees) edit category amounts and existing transactions, reconcile an account against a statement, and rename or consolidate payees. merge_payees previews unless called with apply: true. They need a connection with write scope; if one returns a \"read-only\" error, ask the user to disconnect and reconnect the connector in their MCP client.";

// Builds the MCP server for one request. The server is stateless: the
// Worker creates a fresh instance per request (see index.ts), and everything
// user-specific arrives in `props`, decrypted from the bearer token by
// OAuthProvider.
export const buildServer = (props: Props): McpServer => {
  const server = new McpServer(
    {
      name: "YNAB",
      title: "YNAB",
      version: SERVER_VERSION,
      description:
        "Read and edit your YNAB (You Need A Budget) plans, accounts, categories, and transactions.",
      websiteUrl: "https://github.com/greatgitsby/ynab-connector",
    },
    { instructions: INSTRUCTIONS },
  );

  const getClient = () => new YnabClient(props.ynabAccessToken);
  const getProps = () => props;

  registerListPlans(server, getClient);
  registerListAccounts(server, getClient);
  registerListMonths(server, getClient);
  registerGetMonth(server, getClient);
  registerGetCategory(server, getClient);
  registerListTransactions(server, getClient);
  registerListScheduledTransactions(server, getClient);
  registerListMoneyMovements(server, getClient);
  registerListPayees(server, getClient);
  registerReviewPayees(server, getClient);
  registerTriageInbox(server, getClient);
  registerReflectIncomeExpense(server, getClient);
  registerReflectNetWorth(server, getClient);
  registerAssignToCategories(server, getClient, getProps);
  registerUpdateTransactions(server, getClient, getProps);
  registerReconcileAccount(server, getClient, getProps);
  registerRenamePayees(server, getClient, getProps);
  registerMergePayees(server, getClient, getProps);

  return server;
};
