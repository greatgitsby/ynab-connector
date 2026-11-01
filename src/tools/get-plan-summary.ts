import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  Account,
  Plan,
  MonthDetail,
  YnabClient,
} from "../ynab";
import { result, handleError, fmtMoney } from "../format";

// ---- Result type (zod is the single source of truth; the TS type is
// inferred and the schema doubles as the tool's outputSchema — see docs/internals/structured-output.md).
// Money is in milliunits; counts are integers.

export const PlanSummarySchema = z.object({
  planName: z.string(),
  iso: z.string(),
  accountCounts: z.object({
    onBudget: z.number().int(),
    offBudget: z.number().int(),
  }),
  // Live Ready-to-Assign for the current month.
  readyToAssign: z.number(),
  currentMonth: z.object({
    month: z.string(),
    income: z.number(),
    budgeted: z.number(),
    activity: z.number(),
    ageOfMoney: z.number().nullable(),
  }),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

// ---- Compute (pure)

export const computePlanSummary = (
  plan: Plan,
  accounts: Account[],
  currentMonth: MonthDetail,
): PlanSummary => {
  const iso = plan.currency_format?.iso_code ?? "USD";
  const openAccounts = accounts.filter((a) => !a.closed);
  const onBudget = openAccounts.filter((a) => a.on_budget).length;
  const offBudget = openAccounts.length - onBudget;
  return {
    planName: plan.name,
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

export const renderPlanSummary = (summary: PlanSummary): string => {
  const { planName, iso, accountCounts, readyToAssign, currentMonth } =
    summary;
  const out: string[] = [];
  out.push(`Plan: ${planName}`);
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
  "Summary of a plan: account counts, ready-to-assign, and the current month's income, budgeted, and activity totals.";

export const registerGetPlanSummary = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "get_plan_summary",
    {
      title: "Get Plan Summary",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { plan_id: planIdParam },
      outputSchema: PlanSummarySchema.shape,
    },
    async ({ plan_id }) => {
      try {
        const c = getClient();
        const [planRes, accountsRes, monthRes] = await Promise.all([
          c.getPlan(plan_id),
          c.listAccounts(plan_id),
          c.getMonth(plan_id, "current"),
        ]);
        const summary = computePlanSummary(
          planRes.data.plan,
          accountsRes.data.accounts,
          monthRes.data.month,
        );
        return result(renderPlanSummary(summary), summary);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
