import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
  YnabClient,
  YnabError,
  fromMilli,
  refreshYnabToken,
  type Category,
  type Transaction,
} from "./ynab";
import { ynabAuthHandler, type Props } from "./ynab-auth";

interface Env {
  YNAB_CLIENT_ID: string;
  YNAB_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
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

// MF (monthly funding) targets are per-month; all other types are total targets.
// Cadence-to-months conversion per YNAB API:
//   1 = monthly (× frequency), 2 = weekly (no monthly equivalent — caller falls
//   back to months_to_budget), 3..12 = every (cadence - 1) months,
//   13 = yearly (× frequency, so 12 × freq months), 14 = every 2 years.
const cadenceMonths = (c: Category): number | null => {
  const cadence = c.goal_cadence ?? 0;
  const freq = c.goal_cadence_frequency ?? 1;
  if (cadence === 1) return freq;
  if (cadence === 13) return 12 * freq;
  if (cadence === 14) return 24;
  if (cadence >= 3 && cadence <= 12) return cadence - 1;
  return null;
};

const addMonths = (year: number, month1: number, delta: number) => {
  const t = new Date(Date.UTC(year, month1 - 1 + delta, 1));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1] as const;
};

// For recurring goals, YNAB keeps goal_target_date pinned to the original
// anchor (often years in the past) and tracks the next occurrence via
// goal_months_to_budget — months remaining in the current goal period,
// counting the reference month. Project to the next occurrence and then keep
// adding the cadence interval until the date is strictly in the future (YNAB
// can still report a current-month deadline for a goal that's already met,
// which renders as a past date for any day after the 1st).
const nextGoalDate = (c: Category, refMonth: string): string | null => {
  if (!c.goal_target_date) return null;
  const recurring = (c.goal_cadence ?? 0) > 0;
  const m2b = c.goal_months_to_budget;
  if (!recurring || m2b == null || m2b < 1) return c.goal_target_date;
  const [refY, refM] = refMonth.split("-").map(Number);
  const anchorDay = c.goal_target_date.slice(8, 10);
  let [y, mo] = addMonths(refY, refM, m2b - 1);
  const step = cadenceMonths(c);
  if (step != null && step > 0) {
    const today = new Date();
    const todayIso = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    while (
      `${y}-${String(mo).padStart(2, "0")}-${anchorDay}` <= todayIso
    ) {
      [y, mo] = addMonths(y, mo, step);
    }
  }
  return `${y}-${String(mo).padStart(2, "0")}-${anchorDay}`;
};

const fmtGoal = (c: Category, refMonth: string): string => {
  if (!c.goal_type || c.goal_target == null) return "";
  const suffix = c.goal_type === "MF" ? "/month" : "";
  const parts = [`${fmtMoney(c.goal_target)}${suffix}`];
  const date = nextGoalDate(c, refMonth);
  if (date) parts.push(`by ${date}`);
  if (c.goal_under_funded && c.goal_under_funded > 0)
    parts.push(`underfunded ${fmtMoney(c.goal_under_funded)}`);
  return ` — goal: ${parts.join(", ")}`;
};

const fmtCategoryLine = (
  c: Category,
  refMonth: string,
  includeIds = false,
): string => {
  const idSuffix = includeIds ? ` — id ${c.id}` : "";
  return `- ${c.name}: budgeted ${fmtMoney(c.budgeted)}, activity ${fmtMoney(c.activity)}, balance ${fmtMoney(c.balance)}${fmtGoal(c, refMonth)}${idSuffix}`;
};

const fmtTxLine = (
  t: Transaction,
  opts: { showCategory?: boolean; includeIds?: boolean } = {},
): string => {
  const showCategory = opts.showCategory ?? true;
  const payee = t.payee_name ?? "(no payee)";
  const cat = showCategory
    ? ` → ${t.category_name ?? "(uncategorized)"}`
    : "";
  const approval = t.approved ? "" : " (unapproved)";
  const idSuffix = opts.includeIds ? ` — id ${t.id}` : "";
  return `- ${t.date} ${fmtMoney(t.amount)} ${payee}${cat} [${t.account_name}]${approval}${idSuffix}`;
};

type CategoryActivity = {
  date: string;
  amount: number;
  payee_name: string | null;
  account_name: string;
  approved: boolean;
  parent_id: string;
  sub_id?: string;
  note?: string;
};

const expandForCategory = (
  txs: Transaction[],
  categoryId: string,
): CategoryActivity[] => {
  const out: CategoryActivity[] = [];
  for (const t of txs) {
    if (t.subtransactions && t.subtransactions.length) {
      for (const s of t.subtransactions) {
        if (s.category_id !== categoryId) continue;
        out.push({
          date: t.date,
          amount: s.amount,
          payee_name: s.payee_name ?? t.payee_name,
          account_name: t.account_name,
          approved: t.approved,
          parent_id: t.id,
          sub_id: s.id,
          note: `split from "${t.payee_name ?? "(no payee)"}"`,
        });
      }
    } else if (t.category_id === categoryId) {
      out.push({
        date: t.date,
        amount: t.amount,
        payee_name: t.payee_name,
        account_name: t.account_name,
        approved: t.approved,
        parent_id: t.id,
      });
    }
  }
  return out;
};

const fmtActivityLine = (a: CategoryActivity, includeIds = false): string => {
  const payee = a.payee_name ?? "(no payee)";
  const approval = a.approved ? "" : " (unapproved)";
  const note = a.note ? ` (${a.note})` : "";
  const idSuffix = includeIds
    ? ` — id ${a.sub_id ?? a.parent_id}`
    : "";
  return `- ${a.date} ${fmtMoney(a.amount)} ${payee}${note} [${a.account_name}]${approval}${idSuffix}`;
};

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

    s.registerTool(
      "list_budgets",
      {
        description:
          "List YNAB budgets accessible with the configured token. Returns id, name, currency, and last-modified date. Archived budgets (name contains '(Archived') are hidden by default.",
        inputSchema: {
          include_archived: z.boolean().optional().default(false),
        },
      },
      async ({ include_archived }) => {
        try {
          const { data } = await this.client().listBudgets();
          const budgets = data.budgets.filter(
            (b) => include_archived || !/\(Archived/.test(b.name),
          );
          if (!budgets.length) return text("No budgets found.");
          const lines = budgets.map(
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
          "High-level snapshot of a budget: account counts, ready-to-assign, and the current month's income/budgeted/activity totals.",
        inputSchema: { budget_id: z.string() },
      },
      async ({ budget_id }) => {
        try {
          const c = this.client();
          const [budgetRes, accountsRes, monthRes] = await Promise.all([
            c.getBudget(budget_id),
            c.listAccounts(budget_id),
            c.getMonth(budget_id, "current"),
          ]);
          const iso =
            budgetRes.data.budget.currency_format?.iso_code ?? "USD";
          const openAccounts = accountsRes.data.accounts.filter(
            (a) => !a.closed,
          );
          const onBudget = openAccounts.filter((a) => a.on_budget).length;
          const offBudget = openAccounts.length - onBudget;
          const month = monthRes.data.month;

          const out: string[] = [];
          out.push(`Budget: ${budgetRes.data.budget.name}`);
          out.push(
            `Accounts: ${onBudget} on-budget, ${offBudget} off-budget`,
          );
          // `month.to_be_budgeted` is the live "Ready to Assign" amount the
          // YNAB app shows. The Inflow:RTA category's `balance` is a
          // lifetime-cumulative figure that looks like a huge unassigned pot
          // when it's really just sum-of-inflows minus sum-of-assigned over
          // the budget's history — not user-actionable.
          out.push(`Ready to assign: ${fmtMoney(month.to_be_budgeted, iso)}`);
          out.push("");
          out.push(`Current month (${month.month}):`);
          out.push(`  Income:    ${fmtMoney(month.income, iso)}`);
          out.push(`  Budgeted:  ${fmtMoney(month.budgeted, iso)}`);
          out.push(`  Activity:  ${fmtMoney(month.activity, iso)}`);
          if (month.age_of_money !== null)
            out.push(`  Age of money: ${month.age_of_money} days`);
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
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, include_closed, include_ids }) => {
        try {
          const { data } = await this.client().listAccounts(budget_id);
          const accounts = data.accounts.filter(
            (a) => include_closed || !a.closed,
          );
          const lines = accounts.map((a) => {
            const idSuffix = include_ids ? ` — id ${a.id}` : "";
            return `- ${a.name} [${a.type}] ${a.on_budget ? "(on-budget)" : "(off-budget)"}${a.closed ? " (closed)" : ""}: balance ${fmtMoney(a.balance)}, cleared ${fmtMoney(a.cleared_balance)}, uncleared ${fmtMoney(a.uncleared_balance)}${idSuffix}`;
          });
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
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, month, include_hidden, include_ids }) => {
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
              lines.push(fmtCategoryLine(monthCat, m.month, include_ids));
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
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, since_date, type, limit, include_ids }) => {
        try {
          const { data } = await this.client().listTransactions(budget_id, {
            sinceDate: since_date,
            type,
          });
          const txs = data.transactions.slice(-limit).reverse();
          if (!txs.length) return text("No transactions match.");
          return text(
            txs.map((t) => fmtTxLine(t, { includeIds: include_ids })).join("\n"),
          );
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "triage_inbox",
      {
        description:
          "Day-to-day triage view: ready-to-assign, uncategorized transactions, auto-categorized transactions awaiting review, overspent categories (current month), and underfunded goals (current month) — all in one call. The 'auto-categorized' section is YNAB's guess at a category; it often needs correction before being approved. A transaction appearing in both 'uncategorized' and 'unapproved' is shown only under 'uncategorized'.",
        inputSchema: {
          budget_id: z.string(),
          max_per_section: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .default(25),
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, max_per_section, include_ids }) => {
        try {
          const c = this.client();
          const [uncatRes, unapprovedRes, monthRes] = await Promise.all([
            c.listTransactions(budget_id, { type: "uncategorized" }),
            c.listTransactions(budget_id, { type: "unapproved" }),
            c.getMonth(budget_id, "current"),
          ]);

          // Already-approved transfers between on-budget accounts have no
          // category by design — keep them out of the inbox. Unapproved
          // transfers still surface (the user hasn't OK'd them yet).
          const isInboxItem = (t: Transaction) =>
            t.transfer_account_id == null || !t.approved;
          const uncat = uncatRes.data.transactions
            .filter(isInboxItem)
            .sort((a, b) => b.date.localeCompare(a.date));
          const uncatIds = new Set(uncat.map((t) => t.id));
          const unapproved = unapprovedRes.data.transactions
            .filter((t) => isInboxItem(t) && !uncatIds.has(t.id))
            .sort((a, b) => b.date.localeCompare(a.date));

          const month = monthRes.data.month;
          // Drop YNAB's internal pseudo-categories ("Inflow: Ready to Assign"
          // and "Uncategorized"); the latter aggregates all uncategorized
          // activity and would otherwise show up as a spurious overspent row.
          const monthCats = month.categories.filter(
            (cat) => !cat.hidden && !cat.internal,
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
          out.push(`Triage inbox for month ${month.month}`);
          out.push(`Ready to assign: ${fmtMoney(month.to_be_budgeted)}`);
          out.push("");

          pushSection(
            out,
            "Uncategorized transactions",
            uncat,
            max_per_section,
            (t) => fmtTxLine(t, { showCategory: false, includeIds: include_ids }),
          );
          pushSection(
            out,
            "Auto-categorized (verify category before approving)",
            unapproved,
            max_per_section,
            (t) => fmtTxLine(t, { includeIds: include_ids }),
          );
          pushSection(
            out,
            "Overspent categories (current month)",
            overspent,
            max_per_section,
            (cat) => fmtCategoryLine(cat, month.month, include_ids),
          );
          pushSection(
            out,
            "Underfunded goals (current month)",
            underfunded,
            max_per_section,
            (cat) => {
              const idSuffix = include_ids ? ` — id ${cat.id}` : "";
              const suffix = cat.goal_type === "MF" ? "/month" : "";
              const next = nextGoalDate(cat, month.month);
              const date = next ? ` by ${next}` : "";
              return `- ${cat.name}: underfunded ${fmtMoney(cat.goal_under_funded ?? 0)} (goal ${fmtMoney(cat.goal_target ?? 0)}${suffix}${date})${idSuffix}`;
            },
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
          "Drilldown for one category: its month aggregates (budgeted/activity/balance/goal) plus every transaction in that category for the given month (default 'current'). Split transactions are expanded: only the subtransactions allocated to this category appear, and each is labelled with its parent payee.",
        inputSchema: {
          budget_id: z.string(),
          category_id: z.string(),
          month: z
            .string()
            .optional()
            .default("current")
            .describe("YYYY-MM-01 or 'current'"),
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, category_id, month, include_ids }) => {
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

          const activity = expandForCategory(
            txRes.data.transactions,
            category_id,
          ).sort((a, b) => b.date.localeCompare(a.date));
          const sum = activity.reduce((acc, a) => acc + a.amount, 0);

          const out: string[] = [];
          out.push(`${groupName} → ${cat.name}`);
          out.push(`Month: ${m.month}`);
          out.push(
            `Budgeted: ${fmtMoney(cat.budgeted)}, activity ${fmtMoney(cat.activity)}, balance ${fmtMoney(cat.balance)}${fmtGoal(cat, m.month)}`,
          );
          out.push("");
          out.push(
            `Transactions this month (${activity.length}, sum ${fmtMoney(sum)}):`,
          );
          if (!activity.length) out.push("(none)");
          for (const a of activity) {
            out.push(fmtActivityLine(a, include_ids));
          }
          return text(out.join("\n"));
        } catch (e) {
          return handleError(e);
        }
      },
    );
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
