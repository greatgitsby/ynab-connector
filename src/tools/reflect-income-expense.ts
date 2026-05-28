import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BudgetDetail, Transaction, YnabClient } from "../ynab";
import { resolveMonthWindow } from "../month-window";
import { isInflowRta, isUncategorizedInternal } from "../predicates";
import { text, handleError, padMoney } from "../format";

// ---- Result types

export interface PayeeIncomeRow {
  label: string;
  monthly: Map<string, number>;
}

export interface ExpenseCategoryRow {
  id: string;
  label: string;
  groupName: string;
  monthly: Map<string, number>;
}

export interface ExpenseGroup {
  name: string;
  rows: ExpenseCategoryRow[];
  // Group subtotal per month.
  monthly: Map<string, number>;
}

export interface IncomeExpensePivot {
  budgetName: string;
  iso: string;
  // Months actually present in the window, chronological order.
  window: string[];
  requestedMonths: number;
  truncationNote: string | null;
  income: {
    // Sorted by total income desc.
    rows: PayeeIncomeRow[];
    // Sum of all income rows per month.
    monthly: Map<string, number>;
  };
  // Synthetic Uncategorized row hoisted above the groups, or null if absent.
  uncategorized: ExpenseCategoryRow | null;
  // In budget.category_groups order, hidden groups omitted, empty groups dropped.
  groups: ExpenseGroup[];
  totals: {
    expense: Map<string, number>;
    // income + expense (expense activity is already negative).
    net: Map<string, number>;
  };
}

export interface ComputeOpts {
  monthsBack: number;
}

// ---- Compute (pure)

export const computeIncomeExpensePivot = (
  budget: BudgetDetail,
  transactions: Transaction[],
  opts: ComputeOpts,
): IncomeExpensePivot => {
  const iso = budget.currency_format?.iso_code ?? "USD";
  const win = resolveMonthWindow(budget, opts.monthsBack);
  const window = win.present;
  const monthsInWindow = win.months;
  const winSet = new Set(window);

  // Locate the Inflow: Ready to Assign category id by scanning per-month
  // categories (category_groups[].categories comes back null on /budgets/{id}).
  let inflowRtaId: string | null = null;
  for (const m of monthsInWindow) {
    for (const cat of m.categories ?? []) {
      if (isInflowRta(cat)) {
        inflowRtaId = cat.id;
        break;
      }
    }
    if (inflowRtaId) break;
  }

  // Income by payee — sourced from Inflow: Ready to Assign transactions.
  const incomeByPayee = new Map<string, PayeeIncomeRow>();
  const addIncome = (payee: string | null, date: string, amount: number) => {
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
    for (const t of transactions) {
      if (t.subtransactions?.length) {
        for (const sub of t.subtransactions) {
          if (sub.category_id === inflowRtaId) {
            addIncome(sub.payee_name ?? t.payee_name, t.date, sub.amount);
          }
        }
      } else if (t.category_id === inflowRtaId) {
        addIncome(t.payee_name, t.date, t.amount);
      }
    }
  }

  // Group name lookup + visible group order from budget.category_groups.
  const groupNameById = new Map<string, string>();
  const groupOrder: string[] = [];
  const hiddenGroupIds = new Set<string>();
  for (const grp of budget.category_groups ?? []) {
    if (grp.deleted) continue;
    groupNameById.set(grp.id, grp.name);
    if (grp.hidden) hiddenGroupIds.add(grp.id);
    else groupOrder.push(grp.name);
  }

  // Expense rows aggregated across the window. Uncategorized is hoisted.
  const expenseRows = new Map<string, ExpenseCategoryRow>();
  let uncategorized: ExpenseCategoryRow | null = null;
  for (const m of monthsInWindow) {
    for (const cat of m.categories ?? []) {
      if (cat.deleted || cat.hidden) continue;
      if (isInflowRta(cat)) continue;
      if (isUncategorizedInternal(cat)) {
        if (!uncategorized) {
          uncategorized = {
            id: cat.id,
            label: "Uncategorized Transactions",
            groupName: "",
            monthly: new Map(),
          };
        }
        uncategorized.monthly.set(m.month, cat.activity);
        continue;
      }
      if (hiddenGroupIds.has(cat.category_group_id)) continue;
      const groupName =
        groupNameById.get(cat.category_group_id) ?? "(no group)";
      let row = expenseRows.get(cat.id);
      if (!row) {
        row = { id: cat.id, label: cat.name, groupName, monthly: new Map() };
        expenseRows.set(cat.id, row);
      }
      row.monthly.set(m.month, cat.activity);
    }
  }
  // Drop zero-activity categories.
  for (const [id, row] of expenseRows) {
    if (![...row.monthly.values()].some((v) => v !== 0)) {
      expenseRows.delete(id);
    }
  }
  if (
    uncategorized &&
    ![...uncategorized.monthly.values()].some((v) => v !== 0)
  ) {
    uncategorized = null;
  }

  // Income totals per month.
  const incomeTotal = new Map<string, number>();
  for (const r of incomeByPayee.values()) {
    for (const k of window) {
      incomeTotal.set(
        k,
        (incomeTotal.get(k) ?? 0) + (r.monthly.get(k) ?? 0),
      );
    }
  }
  const incomeRowsSorted = [...incomeByPayee.values()].sort((a, b) => {
    const at = [...a.monthly.values()].reduce((s, v) => s + v, 0);
    const bt = [...b.monthly.values()].reduce((s, v) => s + v, 0);
    return bt - at;
  });

  // Build expense groups (budget order, most-negative row first within each).
  const rowsByGroup = new Map<string, ExpenseCategoryRow[]>();
  for (const row of expenseRows.values()) {
    const arr = rowsByGroup.get(row.groupName);
    if (arr) arr.push(row);
    else rowsByGroup.set(row.groupName, [row]);
  }
  const expenseTotal = new Map<string, number>();
  if (uncategorized) {
    for (const k of window) {
      expenseTotal.set(
        k,
        (expenseTotal.get(k) ?? 0) + (uncategorized.monthly.get(k) ?? 0),
      );
    }
  }
  const groups: ExpenseGroup[] = [];
  for (const groupName of groupOrder) {
    const rows = rowsByGroup.get(groupName);
    if (!rows || !rows.length) continue;
    rows.sort((a, b) => {
      const at = [...a.monthly.values()].reduce((s, v) => s + v, 0);
      const bt = [...b.monthly.values()].reduce((s, v) => s + v, 0);
      return at - bt;
    });
    const groupMonthly = new Map<string, number>();
    for (const r of rows) {
      for (const k of window) {
        const v = r.monthly.get(k) ?? 0;
        groupMonthly.set(k, (groupMonthly.get(k) ?? 0) + v);
        expenseTotal.set(k, (expenseTotal.get(k) ?? 0) + v);
      }
    }
    groups.push({ name: groupName, rows, monthly: groupMonthly });
  }

  const netByMonth = new Map<string, number>();
  for (const k of window) {
    netByMonth.set(
      k,
      (incomeTotal.get(k) ?? 0) + (expenseTotal.get(k) ?? 0),
    );
  }

  return {
    budgetName: budget.name,
    iso,
    window,
    requestedMonths: opts.monthsBack,
    truncationNote: win.truncationNote,
    income: { rows: incomeRowsSorted, monthly: incomeTotal },
    uncategorized,
    groups,
    totals: { expense: expenseTotal, net: netByMonth },
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

const COL_W = 13;
const LABEL_W = 28;

const truncateLabel = (label: string): string =>
  label.length > LABEL_W - 1 ? label.slice(0, LABEL_W - 2) + "…" : label;

const rowLine = (
  label: string,
  monthly: Map<string, number>,
  window: string[],
  iso: string,
): string => {
  let total = 0;
  const parts: string[] = [];
  for (const k of window) {
    const v = monthly.get(k) ?? 0;
    total += v;
    parts.push(padMoney(v, COL_W, iso));
  }
  const avg = window.length ? total / window.length : 0;
  return `${truncateLabel(label).padEnd(LABEL_W)}${parts.join("")}${padMoney(avg, COL_W, iso)}${padMoney(total, COL_W, iso)}`;
};

export const renderIncomeExpensePivot = (
  pivot: IncomeExpensePivot,
  opts: RenderOpts,
): string => {
  const { window, iso, budgetName, income, uncategorized, groups, totals } =
    pivot;
  const winStart = window[0] ?? "(none)";
  const winEnd = window[window.length - 1] ?? "(none)";
  const out: string[] = [];

  out.push(
    `Income v Expense: ${budgetName} — last ${window.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
  );
  if (pivot.truncationNote) out.push(pivot.truncationNote);
  out.push("");

  const headerCols =
    window.map((k) => k.slice(0, 7).padStart(COL_W)).join("") +
    "Average".padStart(COL_W) +
    "Total".padStart(COL_W);
  out.push(`${"".padEnd(LABEL_W)}${headerCols}`);

  out.push("");
  out.push("## Income (by payee)");
  if (!income.rows.length) {
    out.push("(no Inflow: Ready to Assign transactions in window)");
  } else {
    for (const r of income.rows) {
      out.push(rowLine(r.label, r.monthly, window, iso));
    }
    if (income.rows.length > 1) {
      out.push(rowLine("Total Income", income.monthly, window, iso));
    }
  }
  out.push("");

  out.push("## Expense (by category, grouped)");
  if (uncategorized) {
    out.push("");
    const label = opts.includeIds
      ? `${uncategorized.label} — id ${uncategorized.id}`
      : uncategorized.label;
    out.push(rowLine(label, uncategorized.monthly, window, iso));
  }
  for (const grp of groups) {
    out.push("");
    out.push(`[${grp.name}]`);
    for (const r of grp.rows) {
      const label = opts.includeIds
        ? `  ${r.label} — id ${r.id}`
        : `  ${r.label}`;
      out.push(rowLine(label, r.monthly, window, iso));
    }
    out.push(rowLine(`Total ${grp.name}`, grp.monthly, window, iso));
  }
  out.push("");
  out.push(rowLine("Total Expense", totals.expense, window, iso));
  out.push(rowLine("Net Income", totals.net, window, iso));

  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Reflect: income-vs-expense pivot over the last N months (default 3, matching YNAB's default). Income is broken down by payee (scanning transactions categorized as Inflow: Ready to Assign) so you see who paid you, not just the total. Expense rows are every non-Inflow category with activity in the window, grouped by category group with group subtotals. Each row has Average and Total columns. Net Income row at the bottom = Total Income + Total Expense per month (expense activity is already negative).";

export const registerReflectIncomeExpense = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "reflect_income_expense",
    {
      title: "Reflect: Income vs Expense",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
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
        const c = getClient();
        const budgetRes = await c.getBudget(budget_id);
        const budget = budgetRes.data.budget;
        const win = resolveMonthWindow(budget, months_back);
        const sinceDate = win.present[0] ?? budget.first_month;
        const txRes = await c.listTransactions(budget_id, { sinceDate });
        const pivot = computeIncomeExpensePivot(
          budget,
          txRes.data.transactions,
          { monthsBack: months_back },
        );
        return text(renderIncomeExpensePivot(pivot, { includeIds: include_ids }));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
