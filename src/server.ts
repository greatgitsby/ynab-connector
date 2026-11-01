import { McpServer } from "@modelcontextprotocol/server";
import { YnabClient } from "./ynab";
import type { Props } from "./ynab-auth";
import { registerListPlans } from "./tools/list-plans";
import { registerListAccounts } from "./tools/list-accounts";
import { registerGetMonth } from "./tools/get-month";
import { registerListTransactions } from "./tools/list-transactions";
import { registerTriageInbox } from "./tools/triage-inbox";
import { registerReflectNetWorth } from "./tools/reflect-net-worth";
import { registerReflectIncomeExpense } from "./tools/reflect-income-expense";
import { registerSearchPayees } from "./tools/search-payees";
import { registerAssignToCategories } from "./tools/assign-to-categories";
import { registerUpdateTransactions } from "./tools/update-transactions";
import { registerReconcileAccount } from "./tools/reconcile-account";

export const SERVER_VERSION = "0.2.0";

const INSTRUCTIONS =
  'YNAB (You Need A Budget) connector. Read tools return plans, accounts, categories, transactions, and reports. Write tools (assign_to_categories, update_transactions, reconcile_account) edit category amounts and existing transactions, and reconcile an account against a bank statement. ' +
  'Every plan-scoped tool takes an optional plan_id; it defaults to "last-used" (the most recently used plan), so call list_plans only when the user has several plans. ' +
  'Money values in text responses are already converted from YNAB milliunits to currency; structured output and write tools use milliunits. Each line ends with "— id <uuid>"; use that id to refer to the item in later calls. Month parameters accept "YYYY-MM-01" or the literal string "current". ' +
  "For an overview, start with triage_inbox or get_plan_summary. The reflect_* tools report across several months, and get_category_details covers one category. Before passing a payee to update_transactions, look up its id with search_payees. " +
  'Write tools need a connection with write scope. If one returns a "read-only" error, ask the user to disconnect and reconnect the connector in their MCP client.';

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
  registerGetMonth(server, getClient);
  registerListTransactions(server, getClient);
  registerTriageInbox(server, getClient);
  registerReflectNetWorth(server, getClient);
  registerReflectIncomeExpense(server, getClient);
  registerSearchPayees(server, getClient);
  registerAssignToCategories(server, getClient, getProps);
  registerUpdateTransactions(server, getClient, getProps);
  registerReconcileAccount(server, getClient, getProps);

  return server;
};
