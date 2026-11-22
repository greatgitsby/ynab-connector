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
import { registerSetCategoryGoals } from "./tools/set-category-goals";
import { registerCreateCategories } from "./tools/create-categories";
import { registerUpdateCategories } from "./tools/update-categories";
import { registerQueryTransactions } from "./tools/query-transactions";
import { registerGetSnapshot } from "./tools/get-snapshot";
import { registerSuggestSplit } from "./tools/suggest-split";

export const SERVER_VERSION = "0.7.0";

const INSTRUCTIONS =
  "YNAB (You Need A Budget) connector. Tools follow YNAB's API: list_* and get_* return YNAB objects with YNAB's field names, and reflect_* tools are multi-month reports. " +
  'Every plan-scoped tool takes an optional plan_id; it defaults to "last-used" (the most recently used plan), so call list_plans only when the user has several plans. ' +
  'Money in text is already formatted in the plan\'s currency; structured output and write tools use YNAB milliunits (1000 = 1.00), and outflows are negative. Months are "YYYY-MM-01" or "current"; dates are "YYYY-MM-DD". Add include_ids for "— id <uuid>" on each text line; structured output always carries ids. ' +
  "Start with get_snapshot for a compact overview (Ready to Assign, inbox, overspent and underfunded, account balances, recent imports), or triage_inbox for the same inbox as full YNAB objects. get_month shows this month's categories; its `only` and `compact` options trim it. " +
  "query_transactions is the workhorse for transactions: compact rows, any number of account, category, and payee filters by name or id, text search, paging, and group_by payee, category, month, or account with count, total, typical amount, and first and last date. list_transactions returns full YNAB transaction objects for one scope. suggest_split proposes how to split an aggregate charge such as Privacy.com. " +
  "list_scheduled_transactions shows upcoming bills and transfers that are not yet in balances. list_money_movements shows assignments and moves between categories, including money taken from savings goals. review_payees finds duplicate and little-used payees. " +
  "Write tools (assign_to_categories, set_category_goals, create_categories, update_categories, update_transactions, reconcile_account, rename_payees, merge_payees) edit category amounts and goals, create, rename, and move categories, edit existing transactions, reconcile an account against a statement, and rename or consolidate payees. assign_to_categories and update_transactions accept category names as well as ids, and report Ready to Assign and category balances after the write; assign_to_categories also adds or subtracts, funds goals, funds every underfunded goal except named ones, and has dry_run. merge_payees and set_category_goals preview unless called with apply: true. YNAB's API can't hide or delete categories; the user does that in YNAB. They need a connection with write scope; if one returns a \"read-only\" error, ask the user to disconnect and reconnect the connector in their MCP client.";

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
  registerSetCategoryGoals(server, getClient, getProps);
  registerCreateCategories(server, getClient, getProps);
  registerUpdateCategories(server, getClient, getProps);
  registerQueryTransactions(server, getClient);
  registerGetSnapshot(server, getClient);
  registerSuggestSplit(server, getClient);

  return server;
};
