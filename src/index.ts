import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
  YnabClient,
  YnabError,
  fromMilli,
  type Category,
  type Transaction,
} from "./ynab";

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

function pushSection<T>(
  out: string[],
  title: string,
  items: T[],
  cap: number,
  render: (item: T) => string,
): void {
  const header =
    items.length <= cap
      ? `## ${title} (${items.length})`
      : `## ${title} (showing ${cap} of ${items.length})`;
  out.push(header);
  if (!items.length) {
    out.push("(none)");
  } else {
    for (const item of items.slice(0, cap)) out.push(render(item));
  }
  out.push("");
}

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

const fmtCategoryLine = (c: Category): string =>
  `- ${c.name}: budgeted ${fmtMoney(c.budgeted)}, activity ${fmtMoney(c.activity)}, balance ${fmtMoney(c.balance)}${fmtGoal(c)} — id ${c.id}`;

const fmtTxLine = (
  t: Transaction,
  opts: { showCategory?: boolean } = {},
): string => {
  const showCategory = opts.showCategory ?? true;
  const payee = t.payee_name ?? "(no payee)";
  const cat = showCategory
    ? ` → ${t.category_name ?? "(uncategorized)"}`
    : "";
  const approval = t.approved ? "" : " (unapproved)";
  return `- ${t.date} ${fmtMoney(t.amount)} ${payee}${cat} [${t.account_name}]${approval} — id ${t.id}`;
};

export class YnabMcp extends McpAgent<Env> {
  server = new McpServer({ name: "YNAB", version: "0.1.0" });
  private _client?: YnabClient;

  private client() {
    return (this._client ??= new YnabClient(this.env.YNAB_API_TOKEN));
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
      "get_month",
      {
        description:
          "Full month breakdown grouped by category group: income, budgeted, activity, to-be-budgeted, and every category's budgeted/activity/balance/goal for that month. Defaults to the current month.",
        inputSchema: {
          budget_id: z.string(),
          month: z
            .string()
            .optional()
            .default("current")
            .describe("YYYY-MM-01 or 'current'"),
          include_hidden: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, month, include_hidden }) => {
        try {
          const c = this.client();
          const [monthRes, catsRes] = await Promise.all([
            c.getMonth(budget_id, month),
            c.listCategories(budget_id),
          ]);
          const m = monthRes.data.month;
          const byId = new Map(m.categories.map((cat) => [cat.id, cat]));

          const out: string[] = [];
          out.push(`Month: ${m.month}`);
          out.push(`Income:         ${fmtMoney(m.income)}`);
          out.push(`Budgeted:       ${fmtMoney(m.budgeted)}`);
          out.push(`Activity:       ${fmtMoney(m.activity)}`);
          out.push(`To be budgeted: ${fmtMoney(m.to_be_budgeted)}`);
          if (m.age_of_money !== null)
            out.push(`Age of money:   ${m.age_of_money} days`);
          out.push("");

          for (const g of catsRes.data.category_groups) {
            if (g.hidden && !include_hidden) continue;
            const lines: string[] = [];
            for (const groupCat of g.categories) {
              if (groupCat.hidden && !include_hidden) continue;
              const monthCat = byId.get(groupCat.id);
              if (!monthCat) continue;
              lines.push(fmtCategoryLine(monthCat));
            }
            if (!lines.length) continue;
            out.push(`## ${g.name}`);
            out.push(...lines);
            out.push("");
          }
          return text(out.join("\n").trimEnd());
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
          return text(txs.map((t) => fmtTxLine(t)).join("\n"));
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

    s.registerTool(
      "triage_inbox",
      {
        description:
          "Day-to-day triage view: uncategorized transactions, unapproved transactions, overspent categories (current month), and underfunded goals (current month) — all in one call. Transactions appearing in both 'uncategorized' and 'unapproved' are shown only under 'uncategorized'.",
        inputSchema: {
          budget_id: z.string(),
          max_per_section: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .default(25),
        },
      },
      async ({ budget_id, max_per_section }) => {
        try {
          const c = this.client();
          const [uncatRes, unapprovedRes, monthRes] = await Promise.all([
            c.listTransactions(budget_id, { type: "uncategorized" }),
            c.listTransactions(budget_id, { type: "unapproved" }),
            c.getMonth(budget_id, "current"),
          ]);

          const uncat = [...uncatRes.data.transactions].sort((a, b) =>
            b.date.localeCompare(a.date),
          );
          const uncatIds = new Set(uncat.map((t) => t.id));
          const unapproved = unapprovedRes.data.transactions
            .filter((t) => !uncatIds.has(t.id))
            .sort((a, b) => b.date.localeCompare(a.date));

          const monthCats = monthRes.data.month.categories.filter(
            (cat) => !cat.hidden,
          );
          const overspent = monthCats
            .filter((cat) => cat.balance < 0)
            .sort((a, b) => a.balance - b.balance);
          const underfunded = monthCats
            .filter((cat) => (cat.goal_under_funded ?? 0) > 0)
            .sort(
              (a, b) =>
                (b.goal_under_funded ?? 0) - (a.goal_under_funded ?? 0),
            );

          const out: string[] = [];
          out.push(`Triage inbox for month ${monthRes.data.month.month}`);
          out.push("");

          pushSection(
            out,
            "Uncategorized transactions",
            uncat,
            max_per_section,
            (t) => fmtTxLine(t, { showCategory: false }),
          );
          pushSection(
            out,
            "Unapproved transactions",
            unapproved,
            max_per_section,
            (t) => fmtTxLine(t),
          );
          pushSection(
            out,
            "Overspent categories (current month)",
            overspent,
            max_per_section,
            fmtCategoryLine,
          );
          pushSection(
            out,
            "Underfunded goals (current month)",
            underfunded,
            max_per_section,
            (cat) =>
              `- ${cat.name}: underfunded ${fmtMoney(cat.goal_under_funded ?? 0)}${fmtGoal(cat)} — id ${cat.id}`,
          );

          return text(out.join("\n").trimEnd());
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "get_category_details",
      {
        description:
          "Drilldown for one category: its month aggregates (budgeted/activity/balance/goal) plus every transaction in that category for the given month (default 'current'). Note: split transactions are not yet broken out — values reflect non-split transactions only.",
        inputSchema: {
          budget_id: z.string(),
          category_id: z.string(),
          month: z
            .string()
            .optional()
            .default("current")
            .describe("YYYY-MM-01 or 'current'"),
        },
      },
      async ({ budget_id, category_id, month }) => {
        try {
          const c = this.client();
          const monthRes = await c.getMonth(budget_id, month);
          const m = monthRes.data.month;
          const cat = m.categories.find((x) => x.id === category_id);
          if (!cat)
            return text(
              `Category ${category_id} not found in month ${m.month}.`,
            );

          const [catsRes, txRes] = await Promise.all([
            c.listCategories(budget_id),
            c.listTransactions(budget_id, { sinceDate: m.month }),
          ]);

          let groupName = "(unknown group)";
          for (const g of catsRes.data.category_groups) {
            if (g.categories.some((x) => x.id === category_id)) {
              groupName = g.name;
              break;
            }
          }

          const txs = txRes.data.transactions
            .filter((t) => t.category_id === category_id)
            .sort((a, b) => b.date.localeCompare(a.date));
          const sum = txs.reduce((acc, t) => acc + t.amount, 0);

          const out: string[] = [];
          out.push(`${groupName} → ${cat.name}`);
          out.push(`Month: ${m.month}`);
          out.push(
            `Budgeted: ${fmtMoney(cat.budgeted)}, activity ${fmtMoney(cat.activity)}, balance ${fmtMoney(cat.balance)}${fmtGoal(cat)}`,
          );
          out.push("");
          out.push(
            `Transactions this month (${txs.length}, sum ${fmtMoney(sum)}):`,
          );
          if (!txs.length) out.push("(none)");
          for (const t of txs) {
            out.push(fmtTxLine(t, { showCategory: false }));
          }
          return text(out.join("\n"));
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
