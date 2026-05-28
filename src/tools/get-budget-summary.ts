import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Account,
  Budget,
  MonthDetail,
  YnabClient,
} from "../ynab";
import { text, handleError, fmtMoney } from "../format";

// ---- Result type

export interface BudgetSummary {
  budgetName: string;
  iso: string;
  accountCounts: { onBudget: number; offBudget: number };
  // Live Ready-to-Assign for the current month.
  readyToAssign: number;
  currentMonth: {
    month: string;
    income: number;
    budgeted: number;
    activity: number;
    ageOfMoney: number | null;
  };
}

// ---- Compute (pure)

export const computeBudgetSummary = (
  budget: Budget,
  accounts: Account[],
  currentMonth: MonthDetail,
): BudgetSummary => {
  const iso = budget.currency_format?.iso_code ?? "USD";
  const openAccounts = accounts.filter((a) => !a.closed);
  const onBudget = openAccounts.filter((a) => a.on_budget).length;
  const offBudget = openAccounts.length - onBudget;
  return {
    budgetName: budget.name,
    iso,
    accountCounts: { onBudget, offBudget },
    readyToAssign: currentMonth.to_be_budgeted,
    currentMonth: {
      month: currentMonth.month,
      income: currentMonth.income,
      budgeted: currentMonth.budgeted,
      activity: currentMonth.activity,
      ageOfMoney: currentMonth.age_of_money,
    },
  };
};

// ---- Render (pure)

export const renderBudgetSummary = (summary: BudgetSummary): string => {
  const { budgetName, iso, accountCounts, readyToAssign, currentMonth } =
    summary;
  const out: string[] = [];
  out.push(`Budget: ${budgetName}`);
  out.push(
    `Accounts: ${accountCounts.onBudget} on-budget, ${accountCounts.offBudget} off-budget`,
  );
  out.push(`Ready to assign: ${fmtMoney(readyToAssign, iso)}`);
  out.push("");
  out.push(`Current month (${currentMonth.month}):`);
  out.push(`  Income:    ${fmtMoney(currentMonth.income, iso)}`);
  out.push(`  Budgeted:  ${fmtMoney(currentMonth.budgeted, iso)}`);
  out.push(`  Activity:  ${fmtMoney(currentMonth.activity, iso)}`);
  if (currentMonth.ageOfMoney !== null) {
    out.push(`  Age of money: ${currentMonth.ageOfMoney} days`);
  }
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "High-level snapshot of a budget: account counts, ready-to-assign, and the current month's income/budgeted/activity totals.";

export const registerGetBudgetSummary = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "get_budget_summary",
    {
      title: "Get Budget Summary",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { budget_id: z.string() },
    },
    async ({ budget_id }) => {
      try {
        const c = getClient();
        const [budgetRes, accountsRes, monthRes] = await Promise.all([
          c.getBudget(budget_id),
          c.listAccounts(budget_id),
          c.getMonth(budget_id, "current"),
        ]);
        const summary = computeBudgetSummary(
          budgetRes.data.budget,
          accountsRes.data.accounts,
          monthRes.data.month,
        );
        return text(renderBudgetSummary(summary));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
