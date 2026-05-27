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

const fmtPercent = (num: number, total: number): string =>
  total === 0 ? "0.0%" : `${((num / total) * 100).toFixed(1)}%`;

const padMoney = (milli: number, width: number, iso = "USD"): string =>
  fmtMoney(milli, iso).padStart(width);

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

// Builds an array of YYYY-MM-01 strings ending at the current calendar month,
// length monthsBack, clamped to >= firstMonth. End is the current month (not
// +1) because YNAB returns the current month with zeroed activity for
// forward-looking budget rows we don't want to render.
const windowMonths = (monthsBack: number, firstMonth: string): string[] => {
  const today = new Date();
  const endY = today.getUTCFullYear();
  const endM = today.getUTCMonth() + 1;
  const out: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const [y, m] = addMonths(endY, endM, -i);
    const iso = `${y}-${String(m).padStart(2, "0")}-01`;
    if (iso < firstMonth) continue;
    out.push(iso);
  }
  return out;
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

// Human-readable cadence label so `$67` doesn't get misread as a monthly
// target when it's actually weekly. Cadence codes per YNAB API:
//   0 = single goal (no cadence); 1 = monthly × freq; 2 = weekly × freq;
//   3..12 = every (cadence - 1) months; 13 = yearly × freq; 14 = every 2 years.
// MF goals always represent a monthly funding amount regardless of cadence.
const cadenceLabel = (c: Category): string => {
  if (c.goal_type === "MF") return "/month";
  const cadence = c.goal_cadence ?? 0;
  const freq = c.goal_cadence_frequency ?? 1;
  if (cadence === 1) return freq === 1 ? "/month" : ` every ${freq} months`;
  if (cadence === 2) return freq === 1 ? "/week" : ` every ${freq} weeks`;
  if (cadence === 13) return freq === 1 ? "/year" : ` every ${freq} years`;
  if (cadence === 14) return " every 2 years";
  if (cadence >= 3 && cadence <= 12) return ` every ${cadence - 1} months`;
  return "";
};

const fmtGoal = (c: Category, refMonth: string): string => {
  if (!c.goal_type || c.goal_target == null) return "";
  const parts = [`${fmtMoney(c.goal_target)}${cadenceLabel(c)}`];
  const date = nextGoalDate(c, refMonth);
  if (date) parts.push(`by ${date}`);
  if (c.goal_under_funded && c.goal_under_funded > 0)
    parts.push(`needs ${fmtMoney(c.goal_under_funded)} more this month`);
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
              const next = nextGoalDate(cat, month.month);
              const date = next ? ` by ${next}` : "";
              return `- ${cat.name}: needs ${fmtMoney(cat.goal_under_funded ?? 0)} more this month (goal ${fmtMoney(cat.goal_target ?? 0)}${cadenceLabel(cat)}${date})${idSuffix}`;
            },
          );

          return text(out.join("\n").trimEnd());
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "reflect",
      {
        description:
          "Retrospective overview of a budget over the last N months (default 12): top spending categories, monthly trends, current net worth, income vs expense, and age of money — all in one call. Mirrors YNAB's in-app 'Reflect' feature. Backed by a single GET /budgets/{id} call which returns the full month + account snapshot.",
        inputSchema: {
          budget_id: z.string(),
          months_back: z
            .number()
            .int()
            .min(1)
            .max(24)
            .optional()
            .default(12),
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, months_back, include_ids }) => {
        try {
          const TOP_SPEND = 10;
          const TOP_TREND = 5;
          const MAX_ACCOUNTS = 20;

          const { data } = await this.client().getBudget(budget_id);
          const budget = data.budget;
          const iso = budget.currency_format?.iso_code ?? "USD";
          const allMonths = budget.months ?? [];
          const accounts = budget.accounts ?? [];
          const firstMonth = budget.first_month;

          const requested = windowMonths(months_back, firstMonth);
          const monthsByKey = new Map(allMonths.map((m) => [m.month, m]));
          const window = requested.filter((k) => monthsByKey.has(k));
          const monthsInWindow = window.map((k) => monthsByKey.get(k)!);

          const out: string[] = [];
          const winStart = window[0] ?? "(none)";
          const winEnd = window[window.length - 1] ?? "(none)";
          out.push(
            `Reflect: ${budget.name} — last ${window.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
          );
          if (window.length < months_back) {
            out.push(
              `(Budget starts ${firstMonth}; window truncated to ${window.length} of ${months_back} requested months.)`,
            );
          }
          out.push("");

          // --- Aggregator (sections 1 & 2) ---
          type CatAgg = {
            id: string;
            name: string;
            group: string;
            total: number; // milliunits, positive = spending magnitude
            monthly: Map<string, number>; // month → spending magnitude
          };
          const agg = new Map<string, CatAgg>();
          const monthlySpend = new Map<string, number>(); // month → total spending
          for (const m of monthsInWindow) {
            let monthTotal = 0;
            for (const c of m.categories ?? []) {
              if (c.hidden || c.internal || c.deleted) continue;
              const spend = c.activity < 0 ? -c.activity : 0;
              if (spend === 0) continue;
              monthTotal += spend;
              let entry = agg.get(c.id);
              if (!entry) {
                entry = {
                  id: c.id,
                  name: c.name,
                  group: c.category_group_name ?? "",
                  total: 0,
                  monthly: new Map(),
                };
                agg.set(c.id, entry);
              }
              entry.total += spend;
              entry.monthly.set(m.month, (entry.monthly.get(m.month) ?? 0) + spend);
            }
            monthlySpend.set(m.month, monthTotal);
          }
          const totalSpend = [...agg.values()].reduce((s, c) => s + c.total, 0);
          const ranked = [...agg.values()].sort((a, b) => b.total - a.total);

          // --- Section 1: Spending breakdown ---
          pushSection(
            out,
            `Top spending categories — last ${window.length} months`,
            ranked,
            TOP_SPEND,
            (c) => {
              const idSuffix = include_ids ? ` — id ${c.id}` : "";
              return `- ${c.name}: ${fmtMoney(c.total, iso)} (${fmtPercent(c.total, totalSpend)})${idSuffix}`;
            },
          );
          out.push(`Total spending across window: ${fmtMoney(totalSpend, iso)}`);
          out.push("");

          // --- Section 2: Trends ---
          out.push("## Monthly spending trend");
          if (!monthsInWindow.length) {
            out.push("(none)");
          } else {
            for (const m of monthsInWindow) {
              out.push(
                `- ${m.month.slice(0, 7)}: ${fmtMoney(monthlySpend.get(m.month) ?? 0, iso)}`,
              );
            }
          }
          out.push("");

          const topTrend = ranked.slice(0, TOP_TREND);
          const trendHeader =
            ranked.length <= TOP_TREND
              ? `## Top categories month-over-month (${ranked.length})`
              : `## Top categories month-over-month (showing ${TOP_TREND} of ${ranked.length})`;
          out.push(trendHeader);
          if (!topTrend.length) {
            out.push("(none)");
          } else if (window.length === 1) {
            for (const c of topTrend) {
              const only = c.monthly.get(window[0]) ?? 0;
              out.push(`- ${c.name}: ${fmtMoney(only, iso)} (${window[0].slice(0, 7)})`);
            }
          } else {
            for (const c of topTrend) {
              const monthValues = window.map((k) => ({
                month: k,
                v: c.monthly.get(k) ?? 0,
              }));
              const present = monthValues.filter((x) => x.v > 0);
              if (!present.length) {
                out.push(`- ${c.name}: avg ${fmtMoney(0, iso)} (no spending)`);
                continue;
              }
              // Average over months where the category actually had spending,
              // not over the whole window — otherwise one-off purchases get
              // diluted to nonsense like "avg $696, min $4,180, max $4,180".
              const avg = c.total / present.length;
              const min = present.reduce((a, b) => (b.v < a.v ? b : a));
              const max = present.reduce((a, b) => (b.v > a.v ? b : a));
              const cadence =
                present.length === window.length
                  ? ""
                  : ` (${present.length}/${window.length} months)`;
              out.push(
                `- ${c.name}: avg ${fmtMoney(avg, iso)}${cadence}, min ${fmtMoney(min.v, iso)} (${min.month.slice(0, 7)}), max ${fmtMoney(max.v, iso)} (${max.month.slice(0, 7)})`,
              );
            }
          }
          out.push("");

          // --- Section 3: Net worth (current snapshot) ---
          const openAccounts = accounts.filter((a) => !a.closed && !a.deleted);
          const assets = openAccounts
            .filter((a) => a.balance > 0)
            .reduce((s, a) => s + a.balance, 0);
          const liabilities = openAccounts
            .filter((a) => a.balance < 0)
            .reduce((s, a) => s + a.balance, 0);
          out.push("## Net worth (current snapshot)");
          out.push(`Assets:      ${fmtMoney(assets, iso)}`);
          out.push(`Liabilities: ${fmtMoney(liabilities, iso)}`);
          out.push(`Net worth:   ${fmtMoney(assets + liabilities, iso)}`);
          out.push("");
          const sortedAccounts = [...openAccounts].sort(
            (a, b) => b.balance - a.balance,
          );
          pushSection(
            out,
            "By account",
            sortedAccounts,
            MAX_ACCOUNTS,
            (a) => {
              const idSuffix = include_ids ? ` — id ${a.id}` : "";
              return `- ${a.name} [${a.type}] ${a.on_budget ? "(on-budget)" : "(off-budget)"}: ${fmtMoney(a.balance, iso)}${idSuffix}`;
            },
          );
          out.push(
            "Note: YNAB's API only exposes current account balances, not historical snapshots — a true month-over-month net-worth trend isn't available. The income vs expense section below is the closest proxy.",
          );
          out.push("");

          // --- Section 4: Income vs Expense ---
          out.push(`## Income vs expense — last ${window.length} months`);
          const colW = 13;
          out.push(
            `${"".padEnd(12)}${"Income".padStart(colW)}${"Expense".padStart(colW)}${"Net".padStart(colW)}`,
          );
          let incomeSum = 0;
          let expenseSum = 0;
          let netSum = 0;
          let present = 0;
          for (const k of requested) {
            const m = monthsByKey.get(k);
            if (!m) {
              out.push(`- ${k.slice(0, 7)}  (no data)`);
              continue;
            }
            const income = m.income;
            const expense = m.activity - m.income; // negative
            const net = m.activity;
            incomeSum += income;
            expenseSum += expense;
            netSum += net;
            present++;
            out.push(
              `- ${k.slice(0, 7)}  ${padMoney(income, colW, iso)}${padMoney(expense, colW, iso)}${padMoney(net, colW, iso)}`,
            );
          }
          if (present > 0) {
            out.push(
              `- Average   ${padMoney(incomeSum / present, colW, iso)}${padMoney(expenseSum / present, colW, iso)}${padMoney(netSum / present, colW, iso)}`,
            );
          }
          out.push("");

          // --- Section 5: Age of Money ---
          out.push(`## Age of money — last ${window.length} months`);
          const aomVals: number[] = [];
          for (const k of requested) {
            const m = monthsByKey.get(k);
            if (!m) {
              out.push(`- ${k.slice(0, 7)}: (no data)`);
              continue;
            }
            if (m.age_of_money == null) {
              out.push(`- ${k.slice(0, 7)}: (n/a)`);
              continue;
            }
            aomVals.push(m.age_of_money);
            out.push(`- ${k.slice(0, 7)}: ${m.age_of_money} days`);
          }
          if (!aomVals.length) {
            out.push("(age of money not yet available)");
          } else {
            const avg = aomVals.reduce((s, v) => s + v, 0) / aomVals.length;
            out.push(`Average: ${Math.round(avg)} days`);
            if (window.length === 1 || aomVals.length < 2) {
              out.push("Trend: n/a (single data point)");
            } else {
              const delta = aomVals[aomVals.length - 1] - aomVals[0];
              const sign = delta >= 0 ? "+" : "";
              out.push(
                `Trend: ${sign}${delta} days vs ${window.length} months ago`,
              );
            }
          }

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
