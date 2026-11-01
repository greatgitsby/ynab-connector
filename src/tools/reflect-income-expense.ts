import { z } from "zod";
import { includeIdsParam, monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PlanDetail, Transaction, YnabClient } from "../ynab";
import {
  monthEndDate,
  resolveMonthRange,
  resolveMonthWindow,
} from "../month-window";
import { isInflowRta, isUncategorizedInternal } from "../predicates";
import { result, handleError, padMoney } from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see docs/internals/structured-output.md).
// Money is in milliunits; the per-month maps are keyed by month ("YYYY-MM-01")
// and emitted as JSON objects (z.record) so structuredContent round-trips —
// a Map would serialize to "{}". Averages stay z.number().

// Per-month milliunit amounts keyed by month ("YYYY-MM-01").
const MonthlySchema = z.record(z.string(), z.number());

const PayeeIncomeRowSchema = z.object({
  label: z.string(),
  monthly: MonthlySchema,
});
export type PayeeIncomeRow = z.infer<typeof PayeeIncomeRowSchema>;

const ExpenseCategoryRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  group_name: z.string(),
  monthly: MonthlySchema,
});
export type ExpenseCategoryRow = z.infer<typeof ExpenseCategoryRowSchema>;

const ExpenseGroupSchema = z.object({
  name: z.string(),
  rows: z.array(ExpenseCategoryRowSchema),
  // Group subtotal per month.
  monthly: MonthlySchema,
});
export type ExpenseGroup = z.infer<typeof ExpenseGroupSchema>;

export const IncomeExpensePivotSchema = z.object({
  plan_name: z.string(),
  iso: z.string(),
  // Months actually present in the window, chronological order.
  window: z.array(z.string()),
  truncation_note: z.string().nullable(),
  income: z.object({
    // Sorted by total income desc.
    rows: z.array(PayeeIncomeRowSchema),
    // Sum of all income rows per month.
    monthly: MonthlySchema,
  }),
  // Synthetic Uncategorized row hoisted above the groups, or null if absent.
  uncategorized: ExpenseCategoryRowSchema.nullable(),
  // In plan.category_groups order, hidden groups omitted, empty groups dropped.
  groups: z.array(ExpenseGroupSchema),
  totals: z.object({
    expense: MonthlySchema,
    // income + expense (expense activity is already negative).
    net: MonthlySchema,
  }),
});
export type IncomeExpensePivot = z.infer<typeof IncomeExpensePivotSchema>;

export interface ComputeOpts {
  since: string;
  until: string;
}

// ---- Compute (pure)

// Internal working rows use Maps while aggregating; they are converted to the
// JSON-friendly Record shape (mapToRecord) at the return boundary.
interface PayeeIncomeAgg {
  label: string;
  monthly: Map<string, number>;
}
interface ExpenseCategoryAgg {
  id: string;
  label: string;
  groupName: string;
  monthly: Map<string, number>;
}
interface ExpenseGroupAgg {
  name: string;
  rows: ExpenseCategoryAgg[];
  monthly: Map<string, number>;
}

const mapToRecord = (m: Map<string, number>): Record<string, number> =>
  Object.fromEntries(m);

export const computeIncomeExpensePivot = (
  plan: PlanDetail,
  transactions: Transaction[],
  opts: ComputeOpts,
): IncomeExpensePivot => {
  const iso = plan.currency_format?.iso_code ?? "USD";
  const win = resolveMonthWindow(plan.months ?? [], opts.since, opts.until);
  const window = win.present;
  const monthsInWindow = win.months;
  const winSet = new Set(window);

  // Locate the Inflow: Ready to Assign category id by scanning per-month
  // categories (category_groups[].categories comes back null on /plans/{id}).
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
  const incomeByPayee = new Map<string, PayeeIncomeAgg>();
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
            addIncome(sub.payee_name ?? t.payee_name ?? null, t.date, sub.amount);
          }
        }
      } else if (t.category_id === inflowRtaId) {
        addIncome(t.payee_name ?? null, t.date, t.amount);
      }
    }
  }

  // Group name lookup + visible group order from plan.category_groups.
  const groupNameById = new Map<string, string>();
  const groupOrder: string[] = [];
  const hiddenGroupIds = new Set<string>();
  for (const grp of plan.category_groups ?? []) {
    if (grp.deleted) continue;
    groupNameById.set(grp.id, grp.name);
    if (grp.hidden) hiddenGroupIds.add(grp.id);
    else groupOrder.push(grp.name);
  }

  // Expense rows aggregated across the window. Uncategorized is hoisted.
  const expenseRows = new Map<string, ExpenseCategoryAgg>();
  let uncategorized: ExpenseCategoryAgg | null = null;
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

  // Build expense groups (plan order, most-negative row first within each).
  const rowsByGroup = new Map<string, ExpenseCategoryAgg[]>();
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
  const groups: ExpenseGroupAgg[] = [];
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
    plan_name: plan.name,
    iso,
    window,
    truncation_note: win.truncation_note,
    income: {
      rows: incomeRowsSorted.map((r) => ({
        label: r.label,
        monthly: mapToRecord(r.monthly),
      })),
      monthly: mapToRecord(incomeTotal),
    },
    uncategorized: uncategorized
      ? {
          id: uncategorized.id,
          label: uncategorized.label,
          group_name: uncategorized.groupName,
          monthly: mapToRecord(uncategorized.monthly),
        }
      : null,
    groups: groups.map((g) => ({
      name: g.name,
      rows: g.rows.map((r) => ({
        id: r.id,
        label: r.label,
        group_name: r.groupName,
        monthly: mapToRecord(r.monthly),
      })),
      monthly: mapToRecord(g.monthly),
    })),
    totals: { expense: mapToRecord(expenseTotal), net: mapToRecord(netByMonth) },
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
  monthly: Record<string, number>,
  window: string[],
  iso: string,
): string => {
  let total = 0;
  const parts: string[] = [];
  for (const k of window) {
    const v = monthly[k] ?? 0;
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
  const { window, iso, plan_name, income, uncategorized, groups, totals } =
    pivot;
  const winStart = window[0] ?? "(none)";
  const winEnd = window[window.length - 1] ?? "(none)";
  const out: string[] = [];

  out.push(
    `Income v Expense: ${plan_name} — ${window.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
  );
  if (pivot.truncation_note) out.push(pivot.truncation_note);
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
  "Reflect: income against expense for each month in a range (default the " +
  "3 months ending with the current month, YNAB's default). Income rows are " +
  "payees of transactions categorized as Inflow: Ready to Assign. Expense " +
  "rows are each non-Inflow category with activity in the range, grouped by " +
  "category group with subtotals. Each row has Average and Total columns. " +
  "Net Income is Total Income plus Total Expense for each month; expense " +
  "activity is already negative.";

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
        plan_id: planIdParam,
        since_month: monthParam.optional(),
        until_month: monthParam.optional().default("current"),
        include_ids: includeIdsParam,
      },
      outputSchema: IncomeExpensePivotSchema.shape,
    },
    async ({ plan_id, since_month, until_month, include_ids }) => {
      try {
        const c = getClient();
        const range = resolveMonthRange(since_month, until_month, 3);
        const [planRes, txRes] = await Promise.all([
          c.getPlan(plan_id),
          c.listTransactions(plan_id, {
            sinceDate: range.since,
            untilDate: monthEndDate(range.until),
          }),
        ]);
        const pivot = computeIncomeExpensePivot(
          planRes.data.plan,
          txRes.data.transactions,
          range,
        );
        return result(
          renderIncomeExpensePivot(pivot, { includeIds: include_ids }),
          pivot,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
