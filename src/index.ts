import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
  YnabClient,
  YnabError,
  fromMilli,
  refreshYnabToken,
  type Account,
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

// Last day of a YYYY-MM-01 month as YYYY-MM-DD. JS Date day=0 of month m+1
// resolves to the last day of month m.
const monthEndDate = (monthKey: string): string => {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

const daysInMonth = (monthKey: string): number => {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

// Resolve a month spec to a concrete YYYY-MM-01 key. Accepts "current",
// "last_month", or a literal YYYY-MM-01.
const resolveMonthSpec = (spec: string): string => {
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  if (spec === "current") return `${y}-${String(m).padStart(2, "0")}-01`;
  if (spec === "last_month") {
    const [py, pm] = addMonths(y, m, -1);
    return `${py}-${String(pm).padStart(2, "0")}-01`;
  }
  return spec;
};

// Reconstruct each month-end balance by walking backwards from current
// balance and subtracting every transaction dated strictly after the cutoff.
// Transfers cancel naturally — they appear once on each account. Closed
// accounts are included so prior periods stay accurate when an account has
// since been zeroed out and closed.
type NetWorthSnapshot = { net: number; assets: number; liabilities: number };
const historicalNetWorth = (
  accounts: Account[],
  transactions: Transaction[],
  monthKeys: string[],
): Map<string, NetWorthSnapshot> => {
  const valid = accounts.filter((a) => !a.deleted);
  const byAccount = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const arr = byAccount.get(t.account_id);
    if (arr) arr.push(t);
    else byAccount.set(t.account_id, [t]);
  }
  const out = new Map<string, NetWorthSnapshot>();
  for (const key of monthKeys) {
    const cutoff = monthEndDate(key);
    let assets = 0;
    let liabilities = 0;
    for (const a of valid) {
      let bal = a.balance;
      const accTxs = byAccount.get(a.id) ?? [];
      for (const t of accTxs) if (t.date > cutoff) bal -= t.amount;
      if (bal >= 0) assets += bal;
      else liabilities += bal;
    }
    out.set(key, { net: assets + liabilities, assets, liabilities });
  }
  return out;
};

type Outflow = {
  date: string;
  amount: number;
  payee_name: string | null;
  category_name: string | null;
  account_name: string;
  parent_id: string;
  sub_id?: string;
};

// Single largest outflow (most-negative parent or sub). Skips transfers — a
// move between accounts isn't spending even though one side is negative.
const findLargestOutflow = (txs: Transaction[]): Outflow | null => {
  let best: Outflow | null = null;
  const consider = (o: Outflow) => {
    if (!best || o.amount < best.amount) best = o;
  };
  for (const t of txs) {
    if (t.subtransactions?.length) {
      for (const s of t.subtransactions) {
        if (s.amount >= 0) continue;
        consider({
          date: t.date,
          amount: s.amount,
          payee_name: s.payee_name ?? t.payee_name,
          category_name: s.category_name,
          account_name: t.account_name,
          parent_id: t.id,
          sub_id: s.id,
        });
      }
    } else {
      if (t.transfer_account_id != null) continue;
      if (t.amount >= 0) continue;
      consider({
        date: t.date,
        amount: t.amount,
        payee_name: t.payee_name,
        category_name: t.category_name,
        account_name: t.account_name,
        parent_id: t.id,
      });
    }
  }
  return best;
};

// Spending category with the most transactions in `txs`. Subtransactions
// count independently. Transfers, uncategorized rows, and Inflow:RTA are
// skipped — they aren't "spending categories" in the Reflect sense.
const findMostFrequentCategory = (
  txs: Transaction[],
): { categoryName: string; count: number } | null => {
  const counts = new Map<string, number>();
  const bump = (name: string | null) => {
    if (!name || name === "Uncategorized" || name.startsWith("Inflow")) return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const t of txs) {
    if (t.subtransactions?.length) {
      for (const s of t.subtransactions) bump(s.category_name);
    } else {
      if (t.transfer_account_id != null) continue;
      bump(t.category_name);
    }
  }
  let best: { categoryName: string; count: number } | null = null;
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { categoryName: name, count };
  }
  return best;
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
      "reflect_spending_breakdown",
      {
        description:
          "Reflect: spending breakdown over a date range. Mirrors YNAB's in-app Spending Breakdown tab. Returns total spending, average monthly and daily spending, most frequent spending category (by transaction count), single largest outflow (by transaction amount), per-category share sorted desc, and a separate list of categories with net positive activity (refunds, transfers in). Range defaults to the previous calendar month — pass start_month / end_month to widen it.",
        inputSchema: {
          budget_id: z.string(),
          start_month: z
            .string()
            .optional()
            .default("last_month")
            .describe("YYYY-MM-01, 'current', or 'last_month'"),
          end_month: z
            .string()
            .optional()
            .describe(
              "YYYY-MM-01, 'current', or 'last_month'. Defaults to start_month for a single-month view.",
            ),
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, start_month, end_month, include_ids }) => {
        try {
          const c = this.client();
          const start = resolveMonthSpec(start_month);
          const end = resolveMonthSpec(end_month ?? start_month);
          if (start > end) {
            return text(
              `Error: start_month (${start.slice(0, 7)}) is after end_month (${end.slice(0, 7)}).`,
            );
          }
          const budgetRes = await c.getBudget(budget_id);
          const budget = budgetRes.data.budget;
          const allMonths = budget.months ?? [];
          const monthsInRange = allMonths.filter(
            (m) => m.month >= start && m.month <= end,
          );
          if (!monthsInRange.length) {
            return text(
              `No month data in ${start.slice(0, 7)} to ${end.slice(0, 7)} (budget starts ${budget.first_month}).`,
            );
          }
          const endDate = monthEndDate(end);
          const txRes = await c.listTransactions(budget_id, {
            sinceDate: start,
          });
          const txs = txRes.data.transactions.filter(
            (t) => t.date >= start && t.date <= endDate,
          );

          type SpendRow = { id: string; name: string; magnitude: number };
          type PositiveRow = { id: string; name: string; positive: number };
          const spendByCat = new Map<string, SpendRow>();
          const positiveByCat = new Map<string, PositiveRow>();
          let totalSpend = 0;
          for (const m of monthsInRange) {
            for (const cat of m.categories ?? []) {
              if (cat.hidden || cat.deleted || cat.internal) continue;
              if (cat.activity < 0) {
                const row = spendByCat.get(cat.id) ?? {
                  id: cat.id,
                  name: cat.name,
                  magnitude: 0,
                };
                row.magnitude += -cat.activity;
                spendByCat.set(cat.id, row);
                totalSpend += -cat.activity;
              } else if (cat.activity > 0) {
                const row = positiveByCat.get(cat.id) ?? {
                  id: cat.id,
                  name: cat.name,
                  positive: 0,
                };
                row.positive += cat.activity;
                positiveByCat.set(cat.id, row);
              }
            }
          }
          const spending = [...spendByCat.values()].sort(
            (a, b) => b.magnitude - a.magnitude,
          );
          const positive = [...positiveByCat.values()].sort(
            (a, b) => b.positive - a.positive,
          );

          const numMonths = monthsInRange.length;
          const totalDays = monthsInRange.reduce(
            (s, m) => s + daysInMonth(m.month),
            0,
          );
          const monthlyAvg = totalSpend / numMonths;
          const dailyAvg = totalSpend / totalDays;
          const largest = findLargestOutflow(txs);
          const frequent = findMostFrequentCategory(txs);

          const out: string[] = [];
          const rangeLabel =
            start === end
              ? start.slice(0, 7)
              : `${start.slice(0, 7)} to ${end.slice(0, 7)} (${numMonths} months)`;
          out.push(`Spending Breakdown: ${rangeLabel}`);
          out.push("");
          out.push(`Total Spending: ${fmtMoney(totalSpend)}`);
          if (numMonths > 1) {
            out.push(`Average Monthly Spending: ${fmtMoney(monthlyAvg)}`);
          }
          out.push(
            `Average Daily Spending: ${fmtMoney(dailyAvg)} (over ${totalDays} days)`,
          );
          out.push(
            frequent
              ? `Most Frequent Category: ${frequent.categoryName} (${frequent.count} transactions)`
              : "Most Frequent Category: (none)",
          );
          if (largest) {
            const idSuffix = include_ids
              ? ` — id ${largest.sub_id ?? largest.parent_id}`
              : "";
            const cat = largest.category_name
              ? ` → ${largest.category_name}`
              : "";
            out.push(
              `Largest Outflow: ${largest.payee_name ?? "(no payee)"} ${fmtMoney(largest.amount)} on ${largest.date}${cat} [${largest.account_name}]${idSuffix}`,
            );
          } else {
            out.push("Largest Outflow: (none)");
          }
          out.push("");

          pushSection(
            out,
            "Spending by category (sorted desc)",
            spending,
            spending.length,
            (row) => {
              const idSuffix = include_ids ? ` — id ${row.id}` : "";
              return `- ${row.name}: ${fmtMoney(row.magnitude)} (${fmtPercent(row.magnitude, totalSpend)})${idSuffix}`;
            },
          );

          pushSection(
            out,
            "Positive Inflow Categories (refunds, transfers in)",
            positive,
            positive.length,
            (row) => {
              const idSuffix = include_ids ? ` — id ${row.id}` : "";
              return `- ${row.name}: +${fmtMoney(row.positive)}${idSuffix}`;
            },
          );

          return text(out.join("\n").trimEnd());
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "reflect_spending_trends",
      {
        description:
          "Reflect: monthly net activity over the last N months (default 6, matching YNAB's default) with each month's delta from the window average. Net activity = -month.activity, which mirrors what YNAB shows on Spending Trends: positive means non-Inflow categories spent more than they received; negative means refunds/transfers-in exceeded spending. Also lists the top categories ranked by total spending magnitude with their month-over-month average / min / max.",
        inputSchema: {
          budget_id: z.string(),
          months_back: z
            .number()
            .int()
            .min(1)
            .max(24)
            .optional()
            .default(6),
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, months_back, include_ids }) => {
        try {
          const TOP_TREND = 5;
          const { data } = await this.client().getBudget(budget_id);
          const budget = data.budget;
          const iso = budget.currency_format?.iso_code ?? "USD";
          const allMonths = budget.months ?? [];
          const monthsByKey = new Map(allMonths.map((m) => [m.month, m]));
          const requested = windowMonths(months_back, budget.first_month);
          const window = requested.filter((k) => monthsByKey.has(k));
          const monthsInWindow = window.map((k) => monthsByKey.get(k)!);

          const out: string[] = [];
          const winStart = window[0] ?? "(none)";
          const winEnd = window[window.length - 1] ?? "(none)";
          out.push(
            `Spending Trends: ${budget.name} — last ${window.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
          );
          if (window.length < months_back) {
            out.push(
              `(Budget starts ${budget.first_month}; window truncated to ${window.length} of ${months_back} requested months.)`,
            );
          }
          out.push("");

          const monthlyNet = monthsInWindow.map((m) => ({
            month: m.month,
            value: -m.activity,
          }));
          const totalNet = monthlyNet.reduce((s, x) => s + x.value, 0);
          const avgNet = monthlyNet.length ? totalNet / monthlyNet.length : 0;

          const colW = 14;
          const deltaW = 22;
          out.push(`## Monthly net activity (last ${window.length} months)`);
          out.push(
            `${"Month".padEnd(10)}${"Net Activity".padStart(colW)}${"vs Average".padStart(deltaW)}`,
          );
          for (const m of monthlyNet) {
            const delta = m.value - avgNet;
            const arrow = delta >= 0 ? "↑" : "↓";
            const sign = delta >= 0 ? "+" : "";
            const pct =
              avgNet !== 0
                ? ` (${((delta / Math.abs(avgNet)) * 100).toFixed(1)}%)`
                : "";
            const deltaStr = `${arrow} ${sign}${fmtMoney(delta, iso)}${pct}`;
            out.push(
              `${m.month.slice(0, 7).padEnd(10)}${padMoney(m.value, colW, iso)}${deltaStr.padStart(deltaW)}`,
            );
          }
          if (monthlyNet.length) {
            out.push(
              `${"Average".padEnd(10)}${padMoney(avgNet, colW, iso)}`,
            );
          }
          out.push("");

          type CatAgg = {
            id: string;
            name: string;
            total: number;
            monthly: Map<string, number>;
          };
          const agg = new Map<string, CatAgg>();
          for (const m of monthsInWindow) {
            for (const cat of m.categories ?? []) {
              if (cat.hidden || cat.deleted || cat.internal) continue;
              const mag = cat.activity < 0 ? -cat.activity : 0;
              if (mag === 0) continue;
              let row = agg.get(cat.id);
              if (!row) {
                row = { id: cat.id, name: cat.name, total: 0, monthly: new Map() };
                agg.set(cat.id, row);
              }
              row.total += mag;
              row.monthly.set(m.month, (row.monthly.get(m.month) ?? 0) + mag);
            }
          }
          const ranked = [...agg.values()].sort((a, b) => b.total - a.total);
          const topTrend = ranked.slice(0, TOP_TREND);

          out.push(
            ranked.length <= TOP_TREND
              ? `## Top categories month-over-month (${ranked.length})`
              : `## Top categories month-over-month (showing ${TOP_TREND} of ${ranked.length})`,
          );
          if (!topTrend.length) {
            out.push("(none)");
          } else if (window.length === 1) {
            for (const cAgg of topTrend) {
              const only = cAgg.monthly.get(window[0]) ?? 0;
              const idSuffix = include_ids ? ` — id ${cAgg.id}` : "";
              out.push(
                `- ${cAgg.name}: ${fmtMoney(only, iso)} (${window[0].slice(0, 7)})${idSuffix}`,
              );
            }
          } else {
            for (const cAgg of topTrend) {
              const values = window.map((k) => ({
                month: k,
                v: cAgg.monthly.get(k) ?? 0,
              }));
              // Average over months where the category had spending only — a
              // one-off $4,180 charge shouldn't average to $696 across 6 months.
              const present = values.filter((x) => x.v > 0);
              const idSuffix = include_ids ? ` — id ${cAgg.id}` : "";
              if (!present.length) {
                out.push(
                  `- ${cAgg.name}: avg ${fmtMoney(0, iso)} (no spending)${idSuffix}`,
                );
                continue;
              }
              const avg = cAgg.total / present.length;
              const min = present.reduce((a, b) => (b.v < a.v ? b : a));
              const max = present.reduce((a, b) => (b.v > a.v ? b : a));
              const cadence =
                present.length === window.length
                  ? ""
                  : ` (${present.length}/${window.length} months)`;
              out.push(
                `- ${cAgg.name}: avg ${fmtMoney(avg, iso)}${cadence}, min ${fmtMoney(min.v, iso)} (${min.month.slice(0, 7)}), max ${fmtMoney(max.v, iso)} (${max.month.slice(0, 7)})${idSuffix}`,
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
      "reflect_net_worth",
      {
        description:
          "Reflect: net worth snapshot plus a historical month-by-month reconstruction over the last N months (default 5, matching YNAB's default). Historical balances are derived by walking each account's current balance back through transaction history — YNAB's REST API doesn't expose a balance-snapshot endpoint, but transfers cancel naturally so the reconstruction is exact. Also lists every account's current balance.",
        inputSchema: {
          budget_id: z.string(),
          months_back: z
            .number()
            .int()
            .min(1)
            .max(24)
            .optional()
            .default(5),
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, months_back, include_ids }) => {
        try {
          const MAX_ACCOUNTS = 30;
          const c = this.client();
          const budgetRes = await c.getBudget(budget_id);
          const budget = budgetRes.data.budget;
          const iso = budget.currency_format?.iso_code ?? "USD";
          const accounts = budget.accounts ?? [];
          const requested = windowMonths(months_back, budget.first_month);
          // since_date = first month in window. We need every transaction
          // after each month-end cutoff to subtract from current balance; the
          // earliest cutoff is the end of the window's first month, so
          // since_date = window[0] is the tightest fetch that still covers
          // every needed transaction.
          const sinceDate = requested[0] ?? budget.first_month;
          const txRes = await c.listTransactions(budget_id, { sinceDate });
          const snapshots = historicalNetWorth(
            accounts,
            txRes.data.transactions,
            requested,
          );

          const open = accounts.filter((a) => !a.closed && !a.deleted);
          const curAssets = open
            .filter((a) => a.balance > 0)
            .reduce((s, a) => s + a.balance, 0);
          const curLiab = open
            .filter((a) => a.balance < 0)
            .reduce((s, a) => s + a.balance, 0);

          const out: string[] = [];
          const winStart = requested[0] ?? "(none)";
          const winEnd = requested[requested.length - 1] ?? "(none)";
          out.push(
            `Net Worth: ${budget.name} — last ${requested.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
          );
          out.push("");

          out.push("## Current snapshot");
          out.push(`Net Worth:   ${fmtMoney(curAssets + curLiab, iso)}`);
          out.push(`Assets:      ${fmtMoney(curAssets, iso)}`);
          out.push(`Liabilities: ${fmtMoney(curLiab, iso)}`);
          out.push("");

          out.push(
            `## Historical net worth (end of month, last ${requested.length} months)`,
          );
          const colW = 14;
          out.push(
            `${"Month".padEnd(10)}${"Net Worth".padStart(colW)}${"Assets".padStart(colW)}${"Liabilities".padStart(colW)}${"Change".padStart(colW)}`,
          );
          let prevNet: number | null = null;
          for (const k of requested) {
            const snap = snapshots.get(k);
            if (!snap) {
              out.push(`${k.slice(0, 7).padEnd(10)}(no data)`);
              continue;
            }
            let changeStr: string;
            if (prevNet == null) {
              changeStr = "—".padStart(colW);
            } else {
              const delta = snap.net - prevNet;
              const pct =
                prevNet !== 0
                  ? ` (${delta >= 0 ? "+" : ""}${((delta / Math.abs(prevNet)) * 100).toFixed(1)}%)`
                  : "";
              changeStr = `${padMoney(delta, colW, iso)}${pct}`;
            }
            out.push(
              `${k.slice(0, 7).padEnd(10)}${padMoney(snap.net, colW, iso)}${padMoney(snap.assets, colW, iso)}${padMoney(snap.liabilities, colW, iso)}${changeStr}`,
            );
            prevNet = snap.net;
          }
          if (requested.length >= 2) {
            const first = snapshots.get(requested[0]);
            const last = snapshots.get(requested[requested.length - 1]);
            if (first && last) {
              const delta = last.net - first.net;
              const pct =
                first.net !== 0
                  ? ` (${((delta / Math.abs(first.net)) * 100).toFixed(1)}%)`
                  : "";
              out.push(`Range change: ${fmtMoney(delta, iso)}${pct}`);
            }
          }
          out.push("");

          pushSection(
            out,
            "By account (current)",
            [...open].sort((a, b) => b.balance - a.balance),
            MAX_ACCOUNTS,
            (a) => {
              const idSuffix = include_ids ? ` — id ${a.id}` : "";
              return `- ${a.name} [${a.type}] ${a.on_budget ? "(on-budget)" : "(off-budget)"}: ${fmtMoney(a.balance, iso)}${idSuffix}`;
            },
          );

          return text(out.join("\n").trimEnd());
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "reflect_income_expense",
      {
        description:
          "Reflect: income-vs-expense pivot over the last N months (default 3, matching YNAB's default). Income is broken down by payee (scanning transactions categorized as Inflow: Ready to Assign) so you see who paid you, not just the total. Expense rows are every non-Inflow category with activity in the window, grouped by category group with group subtotals. Each row has Average and Total columns. Net Income row at the bottom = Total Income + Total Expense per month (expense activity is already negative).",
        inputSchema: {
          budget_id: z.string(),
          months_back: z
            .number()
            .int()
            .min(1)
            .max(24)
            .optional()
            .default(3),
          include_ids: z.boolean().optional().default(false),
        },
      },
      async ({ budget_id, months_back, include_ids }) => {
        try {
          const c = this.client();
          const budgetRes = await c.getBudget(budget_id);
          const budget = budgetRes.data.budget;
          const iso = budget.currency_format?.iso_code ?? "USD";
          const allMonths = budget.months ?? [];
          const monthsByKey = new Map(allMonths.map((m) => [m.month, m]));
          const requested = windowMonths(months_back, budget.first_month);
          const window = requested.filter((k) => monthsByKey.has(k));
          const monthsInWindow = window.map((k) => monthsByKey.get(k)!);
          const winSet = new Set(window);

          // Find the Inflow: Ready to Assign category id (internal, name
          // starts with "Inflow"). "Uncategorized" is also internal so we
          // can't filter by `internal` alone.
          let inflowRtaId: string | null = null;
          for (const m of monthsInWindow) {
            for (const cat of m.categories ?? []) {
              if (cat.internal && cat.name.startsWith("Inflow")) {
                inflowRtaId = cat.id;
                break;
              }
            }
            if (inflowRtaId) break;
          }

          const txRes = await c.listTransactions(budget_id, {
            sinceDate: window[0] ?? budget.first_month,
          });

          // Income by payee, per month.
          type Row = { label: string; monthly: Map<string, number> };
          const incomeByPayee = new Map<string, Row>();
          const addIncome = (
            payee: string | null,
            date: string,
            amount: number,
          ) => {
            const mKey = `${date.slice(0, 7)}-01`;
            if (!winSet.has(mKey)) return;
            const key = payee ?? "(no payee)";
            let row = incomeByPayee.get(key);
            if (!row) {
              row = { label: key, monthly: new Map() };
              incomeByPayee.set(key, row);
            }
            row.monthly.set(mKey, (row.monthly.get(mKey) ?? 0) + amount);
          };
          if (inflowRtaId) {
            for (const t of txRes.data.transactions) {
              if (t.subtransactions?.length) {
                for (const sub of t.subtransactions) {
                  if (sub.category_id === inflowRtaId)
                    addIncome(
                      sub.payee_name ?? t.payee_name,
                      t.date,
                      sub.amount,
                    );
                }
              } else if (t.category_id === inflowRtaId) {
                addIncome(t.payee_name, t.date, t.amount);
              }
            }
          }

          // category_group_name isn't populated on Category rows in the
          // /budgets/{id} response. category_groups[].categories also comes
          // back null, so we can't lean on that either. What *is* reliable is
          // cat.category_group_id on every per-month Category, paired with the
          // id→name mapping in budget.category_groups[].
          const groupNameById = new Map<string, string>();
          const groupOrder: string[] = [];
          const hiddenGroupIds = new Set<string>();
          for (const grp of budget.category_groups ?? []) {
            if (grp.deleted) continue;
            groupNameById.set(grp.id, grp.name);
            if (grp.hidden) hiddenGroupIds.add(grp.id);
            else groupOrder.push(grp.name);
          }

          // Expense rows: every non-Inflow category active in the window.
          // YNAB's UI hoists the internal "Uncategorized" category out of its
          // group and renders it as a single row above the groups, so we do
          // the same.
          type ExpenseRow = Row & { id: string; group: string };
          const expenseRows = new Map<string, ExpenseRow>();
          let uncategorizedRow: ExpenseRow | null = null;
          for (const m of monthsInWindow) {
            for (const cat of m.categories ?? []) {
              if (cat.deleted || cat.hidden) continue;
              if (cat.internal && cat.name.startsWith("Inflow")) continue;
              const isUncategorized = cat.internal && cat.name === "Uncategorized";
              if (isUncategorized) {
                if (!uncategorizedRow)
                  uncategorizedRow = {
                    id: cat.id,
                    label: "Uncategorized Transactions",
                    group: "",
                    monthly: new Map(),
                  };
                uncategorizedRow.monthly.set(m.month, cat.activity);
                continue;
              }
              if (hiddenGroupIds.has(cat.category_group_id)) continue;
              const groupName =
                groupNameById.get(cat.category_group_id) ?? "(no group)";
              let row = expenseRows.get(cat.id);
              if (!row) {
                row = {
                  id: cat.id,
                  label: cat.name,
                  group: groupName,
                  monthly: new Map(),
                };
                expenseRows.set(cat.id, row);
              }
              row.monthly.set(m.month, cat.activity);
            }
          }
          // Drop categories with no activity at all in the window. Categories
          // whose net is positive (refunds > spending) are kept — YNAB's UI
          // shows them in-place as positive values rather than excluding them.
          for (const [id, row] of expenseRows) {
            const hasActivity = [...row.monthly.values()].some((v) => v !== 0);
            if (!hasActivity) expenseRows.delete(id);
          }
          if (
            uncategorizedRow &&
            ![...uncategorizedRow.monthly.values()].some((v) => v !== 0)
          ) {
            uncategorizedRow = null;
          }
          const rowsByGroup = new Map<string, ExpenseRow[]>();
          for (const row of expenseRows.values()) {
            const arr = rowsByGroup.get(row.group);
            if (arr) arr.push(row);
            else rowsByGroup.set(row.group, [row]);
          }

          // Render. Column widths tuned for a 3–6 month default; longer
          // windows still work, just wider.
          const colW = 13;
          const labelW = 28;
          const out: string[] = [];
          const winStart = window[0] ?? "(none)";
          const winEnd = window[window.length - 1] ?? "(none)";
          out.push(
            `Income v Expense: ${budget.name} — last ${window.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
          );
          if (window.length < months_back) {
            out.push(
              `(Budget starts ${budget.first_month}; window truncated to ${window.length} of ${months_back} requested months.)`,
            );
          }
          out.push("");

          const headerCols =
            window.map((k) => k.slice(0, 7).padStart(colW)).join("") +
            "Average".padStart(colW) +
            "Total".padStart(colW);
          out.push(`${"".padEnd(labelW)}${headerCols}`);

          const rowLine = (label: string, monthly: Map<string, number>) => {
            let total = 0;
            const parts: string[] = [];
            for (const k of window) {
              const v = monthly.get(k) ?? 0;
              total += v;
              parts.push(padMoney(v, colW, iso));
            }
            const avg = window.length ? total / window.length : 0;
            const truncated =
              label.length > labelW - 1
                ? label.slice(0, labelW - 2) + "…"
                : label;
            return `${truncated.padEnd(labelW)}${parts.join("")}${padMoney(avg, colW, iso)}${padMoney(total, colW, iso)}`;
          };

          out.push("");
          out.push("## Income (by payee)");
          const incomeRows = [...incomeByPayee.values()].sort((a, b) => {
            const at = [...a.monthly.values()].reduce((s, v) => s + v, 0);
            const bt = [...b.monthly.values()].reduce((s, v) => s + v, 0);
            return bt - at;
          });
          const incomeTotal = new Map<string, number>();
          if (!incomeRows.length) {
            out.push("(no Inflow: Ready to Assign transactions in window)");
          } else {
            for (const r of incomeRows) {
              out.push(rowLine(r.label, r.monthly));
              for (const k of window) {
                incomeTotal.set(
                  k,
                  (incomeTotal.get(k) ?? 0) + (r.monthly.get(k) ?? 0),
                );
              }
            }
            if (incomeRows.length > 1)
              out.push(rowLine("Total Income", incomeTotal));
          }
          out.push("");

          out.push("## Expense (by category, grouped)");
          const expenseTotal = new Map<string, number>();
          if (uncategorizedRow) {
            out.push("");
            const label = include_ids
              ? `${uncategorizedRow.label} — id ${uncategorizedRow.id}`
              : uncategorizedRow.label;
            out.push(rowLine(label, uncategorizedRow.monthly));
            for (const k of window) {
              const v = uncategorizedRow.monthly.get(k) ?? 0;
              expenseTotal.set(k, (expenseTotal.get(k) ?? 0) + v);
            }
          }
          for (const groupName of groupOrder) {
            const rows = rowsByGroup.get(groupName);
            if (!rows || !rows.length) continue;
            out.push("");
            out.push(`[${groupName}]`);
            // Most negative (biggest expense) first within group.
            rows.sort((a, b) => {
              const at = [...a.monthly.values()].reduce((s, v) => s + v, 0);
              const bt = [...b.monthly.values()].reduce((s, v) => s + v, 0);
              return at - bt;
            });
            const groupTotal = new Map<string, number>();
            for (const r of rows) {
              const label = include_ids ? `  ${r.label} — id ${r.id}` : `  ${r.label}`;
              out.push(rowLine(label, r.monthly));
              for (const k of window) {
                const v = r.monthly.get(k) ?? 0;
                groupTotal.set(k, (groupTotal.get(k) ?? 0) + v);
                expenseTotal.set(k, (expenseTotal.get(k) ?? 0) + v);
              }
            }
            out.push(rowLine(`Total ${groupName}`, groupTotal));
          }
          out.push("");
          out.push(rowLine("Total Expense", expenseTotal));

          const netByMonth = new Map<string, number>();
          for (const k of window) {
            netByMonth.set(
              k,
              (incomeTotal.get(k) ?? 0) + (expenseTotal.get(k) ?? 0),
            );
          }
          out.push(rowLine("Net Income", netByMonth));

          return text(out.join("\n").trimEnd());
        } catch (e) {
          return handleError(e);
        }
      },
    );

    s.registerTool(
      "reflect_age_of_money",
      {
        description:
          "Reflect: age-of-money trend over the last N months (default 5). Age of money is YNAB's measure of how long money sits in accounts between earning and spending. Returns the current value (latest month), monthly history, average, and start-to-end delta.",
        inputSchema: {
          budget_id: z.string(),
          months_back: z
            .number()
            .int()
            .min(1)
            .max(24)
            .optional()
            .default(5),
        },
      },
      async ({ budget_id, months_back }) => {
        try {
          const { data } = await this.client().getBudget(budget_id);
          const budget = data.budget;
          const allMonths = budget.months ?? [];
          const monthsByKey = new Map(allMonths.map((m) => [m.month, m]));
          const requested = windowMonths(months_back, budget.first_month);

          const out: string[] = [];
          const winStart = requested[0] ?? "(none)";
          const winEnd = requested[requested.length - 1] ?? "(none)";
          out.push(
            `Age of Money: ${budget.name} — last ${requested.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
          );
          out.push("");

          const latest = monthsByKey.get(requested[requested.length - 1] ?? "");
          if (latest?.age_of_money != null) {
            out.push(`Current: ${latest.age_of_money} days`);
            out.push("");
          }

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
            out.push("");
            out.push("(age of money not yet available)");
          } else {
            const avg = aomVals.reduce((s, v) => s + v, 0) / aomVals.length;
            out.push("");
            out.push(`Average: ${Math.round(avg)} days`);
            if (aomVals.length < 2) {
              out.push("Trend: n/a (single data point)");
            } else {
              const delta = aomVals[aomVals.length - 1] - aomVals[0];
              const sign = delta >= 0 ? "+" : "";
              out.push(
                `Trend: ${sign}${delta} days vs ${aomVals.length} months ago`,
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
