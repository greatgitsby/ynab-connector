import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { YnabClient, refreshYnabToken } from "./ynab";
import { ynabAuthHandler, type Props } from "./ynab-auth";
import { registerListBudgets } from "./tools/list-budgets";
import { registerGetBudgetSummary } from "./tools/get-budget-summary";
import { registerListAccounts } from "./tools/list-accounts";
import { registerGetMonth } from "./tools/get-month";
import { registerListTransactions } from "./tools/list-transactions";
import { registerTriageInbox } from "./tools/triage-inbox";
import { registerReflectSpendingBreakdown } from "./tools/reflect-spending-breakdown";
import { registerReflectSpendingTrends } from "./tools/reflect-spending-trends";
import { registerReflectNetWorth } from "./tools/reflect-net-worth";
import { registerReflectIncomeExpense } from "./tools/reflect-income-expense";
import { registerReflectAgeOfMoney } from "./tools/reflect-age-of-money";
import { registerGetCategoryDetails } from "./tools/get-category-details";

interface Env {
  YNAB_CLIENT_ID: string;
  YNAB_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace<YnabMcp>;
}

export class YnabMcp extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "YNAB", version: "0.1.0" });

  // The YNAB access token lives in this.props. Build a fresh client per
  // request so token rotation (on 401) is naturally visible to subsequent
  // tool calls within the same MCP session.
  private client() {
    // Tool handlers only fire after OAuth completes, so props is always set.
    const props = this.props!;
    return new YnabClient(props.ynabAccessToken, async () => {
      const next = await refreshYnabToken({
        client_id: this.env.YNAB_CLIENT_ID,
        client_secret: this.env.YNAB_CLIENT_SECRET,
        refresh_token: props.ynabRefreshToken,
      });
      // Mutate the in-memory props so the next tool call sees the new token.
      // The provider's encrypted bearer still holds the old token until the
      // Claude.ai-side access token refreshes (tokenExchangeCallback re-runs
      // and re-stores); that's fine — the YnabClient's 401 retry will refresh
      // again if needed.
      props.ynabAccessToken = next.access_token;
      props.ynabRefreshToken = next.refresh_token;
      props.ynabExpiresAt = Math.floor(Date.now() / 1000) + next.expires_in;
      return next.access_token;
    });
  }

  async init() {
    const s = this.server;
    const getClient = () => this.client();

    registerListBudgets(s, getClient);
    registerGetBudgetSummary(s, getClient);
    registerListAccounts(s, getClient);
    registerGetMonth(s, getClient);
    registerListTransactions(s, getClient);
    registerTriageInbox(s, getClient);
    registerReflectSpendingBreakdown(s, getClient);
    registerReflectSpendingTrends(s, getClient);
    registerReflectNetWorth(s, getClient);
    registerReflectIncomeExpense(s, getClient);
    registerReflectAgeOfMoney(s, getClient);
    registerGetCategoryDetails(s, getClient);
  }
}

// Claude.ai discovers this server's authorization endpoints via RFC 9728
// protected-resource metadata (served automatically by OAuthProvider) and
// walks the user through YNAB OAuth via /authorize → YNAB → /callback.
// completeAuthorization() then issues an MCP bearer to Claude.ai with the
// per-user YNAB tokens encrypted into `props`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default new OAuthProvider({
  apiHandler: YnabMcp.serve("/mcp") as any,
  apiRoute: "/mcp",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: ynabAuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read-only"],
});
