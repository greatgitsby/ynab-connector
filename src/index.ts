import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { YnabClient, YnabError, fromMilli, type Category } from "./ynab";

interface Env {
  YNAB_API_TOKEN: string;
  CONNECTOR_AUTH_TOKEN: string;
  MCP_OBJECT: DurableObjectNamespace<YnabMcp>;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

const handleError = (e: unknown) => {
  if (e instanceof YnabError) return text(`YNAB error ${e.status}: ${e.body}`);
  return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
};

const fmtMoney = (milli: number, iso = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: iso }).format(
    fromMilli(milli),
  );

// YNAB goal_type codes: TB=target balance, TBD=target balance by date,
// MF=monthly funding, NEED=plan your spending, DEBT=debt payoff.
const GOAL_LABEL: Record<string, string> = {
  TB: "target balance",
  TBD: "target balance by date",
  MF: "monthly target",
  NEED: "needed for spending",
  DEBT: "debt payoff",
};

const fmtGoal = (c: Category): string => {
  if (!c.goal_type || c.goal_target == null) return "";
  const label = GOAL_LABEL[c.goal_type] ?? c.goal_type;
  const parts = [`${label} ${fmtMoney(c.goal_target)}`];
  if (c.goal_target_date) parts.push(`by ${c.goal_target_date}`);
  if (c.goal_under_funded && c.goal_under_funded > 0)
    parts.push(`underfunded ${fmtMoney(c.goal_under_funded)}`);
  if (c.goal_percentage_complete != null)
    parts.push(`${c.goal_percentage_complete}% funded`);
  return ` — goal: ${parts.join(", ")}`;
};

export class YnabMcp extends McpAgent<Env> {
  server = new McpServer({ name: "YNAB", version: "0.1.0" });

  private client() {
    return new YnabClient(this.env.YNAB_API_TOKEN);
  }

  async init() {
    const s = this.server;

    s.registerTool(
      "list_budgets",
      {
        description:
          "List all YNAB budgets accessible with the configured token. Returns id, name, currency, and last-modified date.",
        inputSchema: {},
      },
      async () => {
        try {
          const { data } = await this.client().listBudgets();
          if (!data.budgets.length) return text("No budgets found.");
          const lines = data.budgets.map(
            (b) =>
              `- ${b.name} (id: ${b.id}) — ${b.currency_format?.iso_code ?? "USD"}, last modified ${b.last_modified_on}`,
          );
          return text(lines.join("\n"));
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "get_budget_summary",
      {
        description:
          "Get a high-level snapshot of a budget: on-budget accounts with balances, and the current month's income/budgeted/activity/to-be-budgeted totals.",
        inputSchema: { budget_id: z.string() },
      },
      async ({ budget_id }) => {
        try {
          const c = this.client();
          const [budgetRes, accountsRes, monthsRes] = await Promise.all([
            c.getBudget(budget_id),
            c.listAccounts(budget_id),
            c.listMonths(budget_id),
          ]);
          const iso =
            budgetRes.data.budget.currency_format?.iso_code ?? "USD";
          const accounts = accountsRes.data.accounts
            .filter((a) => !a.closed && a.on_budget)
            .map(
              (a) =>
                `  - ${a.name} (${a.type}): ${fmtMoney(a.balance, iso)}`,
            );
          const current = monthsRes.data.months[0];
          const out: string[] = [];
          out.push(`Budget: ${budgetRes.data.budget.name}`);
          out.push("");
          out.push("On-budget accounts:");
          out.push(...accounts);
          out.push("");
          if (current) {
            out.push(`Current month (${current.month}):`);
            out.push(`  Income:          ${fmtMoney(current.income, iso)}`);
            out.push(`  Budgeted:        ${fmtMoney(current.budgeted, iso)}`);
            out.push(`  Activity:        ${fmtMoney(current.activity, iso)}`);
            out.push(
              `  To be budgeted:  ${fmtMoney(current.to_be_budgeted, iso)}`,
            );
            if (current.age_of_money !== null)
              out.push(`  Age of money:    ${current.age_of_money} days`);
          }
          return text(out.join("\n"));
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "list_accounts",
      {
        description: "List all accounts in a budget with balances.",
        inputSchema: {
          budget_id: z.string(),
          include_closed: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, include_closed }) => {
        try {
          const { data } = await this.client().listAccounts(budget_id);
          const accounts = data.accounts.filter(
            (a) => include_closed || !a.closed,
          );
          const lines = accounts.map(
            (a) =>
              `- ${a.name} [${a.type}] ${a.on_budget ? "(on-budget)" : "(off-budget)"}${a.closed ? " (closed)" : ""}: balance ${fmtMoney(a.balance)}, cleared ${fmtMoney(a.cleared_balance)}, uncleared ${fmtMoney(a.uncleared_balance)} — id ${a.id}`,
          );
          return text(lines.join("\n") || "No accounts.");
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "list_categories",
      {
        description:
          "List all categories in a budget, grouped by category group, with budgeted/activity/balance for the current month.",
        inputSchema: {
          budget_id: z.string(),
          include_hidden: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, include_hidden }) => {
        try {
          const { data } = await this.client().listCategories(budget_id);
          const out: string[] = [];
          for (const g of data.category_groups) {
            if (g.hidden && !include_hidden) continue;
            out.push(`## ${g.name}`);
            for (const c of g.categories) {
              if (c.hidden && !include_hidden) continue;
              out.push(
                `- ${c.name}: budgeted ${fmtMoney(c.budgeted)}, activity ${fmtMoney(c.activity)}, balance ${fmtMoney(c.balance)}${fmtGoal(c)} — id ${c.id}`,
              );
            }
            out.push("");
          }
          return text(out.join("\n").trim() || "No categories.");
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "get_month",
      {
        description:
          "Get a specific month's budget breakdown: income, budgeted, activity, to-be-budgeted, and every category's budgeted/activity/balance for that month. Use 'current' for the current month, or YYYY-MM-01 for a specific month.",
        inputSchema: {
          budget_id: z.string(),
          month: z
            .string()
            .describe("YYYY-MM-01 or 'current'"),
        },
      },
      async ({ budget_id, month }) => {
        try {
          const { data } = await this.client().getMonth(budget_id, month);
          const m = data.month;
          const out: string[] = [];
          out.push(`Month: ${m.month}`);
          out.push(`Income:         ${fmtMoney(m.income)}`);
          out.push(`Budgeted:       ${fmtMoney(m.budgeted)}`);
          out.push(`Activity:       ${fmtMoney(m.activity)}`);
          out.push(`To be budgeted: ${fmtMoney(m.to_be_budgeted)}`);
          if (m.age_of_money !== null)
            out.push(`Age of money:   ${m.age_of_money} days`);
          out.push("");
          out.push("Categories:");
          for (const c of m.categories.filter((c) => !c.hidden)) {
            out.push(
              `- ${c.name}: budgeted ${fmtMoney(c.budgeted)}, activity ${fmtMoney(c.activity)}, balance ${fmtMoney(c.balance)}${fmtGoal(c)} — id ${c.id}`,
            );
          }
          return text(out.join("\n"));
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "list_transactions",
      {
        description:
          "List transactions in a budget. Optionally filter by since_date (YYYY-MM-DD) and/or type ('uncategorized' or 'unapproved').",
        inputSchema: {
          budget_id: z.string(),
          since_date: z.string().optional(),
          type: z.enum(["uncategorized", "unapproved"]).optional(),
          limit: z.number().int().positive().max(500).optional().default(100),
        },
      },
      async ({ budget_id, since_date, type, limit }) => {
        try {
          const { data } = await this.client().listTransactions(budget_id, {
            sinceDate: since_date,
            type,
          });
          const txs = data.transactions.slice(-limit).reverse();
          if (!txs.length) return text("No transactions match.");
          const lines = txs.map(
            (t) =>
              `- ${t.date} ${fmtMoney(t.amount)} ${t.payee_name ?? "(no payee)"} → ${t.category_name ?? "(uncategorized)"} [${t.account_name}]${t.approved ? "" : " (unapproved)"} — id ${t.id}`,
          );
          return text(lines.join("\n"));
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "list_payees",
      {
        description: "List payees in a budget.",
        inputSchema: { budget_id: z.string() },
      },
      async ({ budget_id }) => {
        try {
          const { data } = await this.client().listPayees(budget_id);
          const lines = data.payees.map(
            (p) =>
              `- ${p.name}${p.transfer_account_id ? " (transfer)" : ""} — id ${p.id}`,
          );
          return text(lines.join("\n") || "No payees.");
        } catch (e) {
          return handleError(e);
        }
      },
    );
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Treat the URL path itself as the secret: requests must hit /mcp/<CONNECTOR_AUTH_TOKEN>.
// claude.ai's connector UI doesn't let you set custom headers, so a secret URL is the
// only practical way to gate the endpoint without full OAuth.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const expected = env.CONNECTOR_AUTH_TOKEN;
    if (!expected) {
      return new Response("Server missing CONNECTOR_AUTH_TOKEN", { status: 500 });
    }
    const prefix = `/mcp/${expected}`;
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      const supplied = url.pathname.slice("/mcp/".length).split("/")[0];
      if (!timingSafeEqual(supplied, expected)) {
        return new Response("Not found", { status: 404 });
      }
      return YnabMcp.serve(prefix).fetch(request, env, ctx);
    }
    if (url.pathname === "/") {
      return new Response("YNAB MCP connector. Endpoint is at /mcp/<secret>.", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
