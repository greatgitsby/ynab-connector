import { z } from "zod";
import { includeIdsParam, monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, MonthDetail, YnabClient } from "../ynab";
import { CategorySchema } from "../wire";
import { result, handleError, fmtMoney, fmtCategoryLine } from "../format";
import { resolveMonth, resolveMonthWindow } from "../month-window";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const HistoryRowSchema = z.object({
  month: z.string(),
  budgeted: z.number().int(),
  activity: z.number().int(),
  balance: z.number().int(),
  goal_target: z.number().int().nullable(),
  goal_under_funded: z.number().int().nullable(),
  // True when the goal was fully funded that month; null without a goal.
  goal_met: z.boolean().nullable(),
});

export const CategoryReportSchema = z.object({
  iso: z.string(),
  month: z.string(),
  category: CategorySchema,
  // Chronological, ending at `month`. Empty unless since_month was given.
  history: z.array(HistoryRowSchema),
  truncation_note: z.string().nullable(),
});
export type CategoryReport = z.infer<typeof CategoryReportSchema>;

// ---- Compute (pure)

// `planMonths` comes from GET /plans/{id}, whose per-month goal_* fields are
// that month's own funding state.
export const computeCategoryReport = (
  category: Category,
  planMonths: MonthDetail[],
  opts: { month: string; since: string | null; iso: string },
): CategoryReport => {
  const win = opts.since
    ? resolveMonthWindow(planMonths, opts.since, opts.month)
    : null;
  const history = (win?.months ?? []).flatMap((m) => {
    const c = m.categories.find((x) => x.id === category.id);
    if (!c) return [];
    const hasGoal = !!c.goal_type && c.goal_target != null;
    return [
      {
        month: m.month,
        budgeted: c.budgeted,
        activity: c.activity,
        balance: c.balance,
        goal_target: hasGoal ? (c.goal_target ?? null) : null,
        goal_under_funded: hasGoal ? (c.goal_under_funded ?? 0) : null,
        goal_met: hasGoal ? (c.goal_under_funded ?? 0) <= 0 : null,
      },
    ];
  });
  return {
    iso: opts.iso,
    month: opts.month,
    category,
    history,
    truncation_note: win?.truncation_note ?? null,
  };
};

// ---- Render (pure)

export const renderCategoryReport = (
  r: CategoryReport,
  opts: { includeIds: boolean },
): string => {
  const { iso } = r;
  const out = [
    `${r.category.category_group_name ?? "(no group)"} → ${r.category.name}, ${r.month}`,
    fmtCategoryLine(r.category, r.month, iso, opts.includeIds),
  ];
  if (r.category.note) out.push(`Note: ${r.category.note}`);
  if (r.history.length) {
    const goalRows = r.history.filter((h) => h.goal_met != null);
    const met = goalRows.filter((h) => h.goal_met).length;
    out.push("", "## History");
    if (goalRows.length) {
      out.push(`Goal fully funded in ${met} of ${goalRows.length} months.`);
    }
    for (const h of r.history) {
      const goal =
        h.goal_met == null
          ? ""
          : h.goal_met
            ? ", goal met"
            : `, goal short ${fmtMoney(h.goal_under_funded ?? 0, iso)}`;
      out.push(
        `- ${h.month.slice(0, 7)}: assigned ${fmtMoney(h.budgeted, iso)}, activity ${fmtMoney(h.activity, iso)}, available ${fmtMoney(h.balance, iso)}${goal}`,
      );
    }
  }
  if (r.truncation_note) out.push(r.truncation_note);
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "One category in one month (default current): assigned (budgeted), " +
  "activity, available (balance), goal, and note. Pass since_month for its " +
  "month-by-month history up to `month`, including whether the goal was " +
  "fully funded each month, to see whether it is funded steadily or caught " +
  "up late. For the category's transactions use list_transactions with " +
  "category_id.";

export const registerGetCategory = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "get_category",
    {
      title: "Get Category",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        category_id: z.string(),
        month: monthParam.optional().default("current"),
        since_month: monthParam.optional(),
        include_ids: includeIdsParam,
      },
      outputSchema: CategoryReportSchema.shape,
    },
    async ({ plan_id, category_id, month, since_month, include_ids }) => {
      try {
        const c = getClient();
        const [catRes, iso, planRes] = await Promise.all([
          c.getMonthCategory(plan_id, month, category_id),
          c.planIso(plan_id),
          since_month ? c.getPlan(plan_id) : null,
        ]);
        const report = computeCategoryReport(
          catRes.data.category,
          planRes?.data.plan.months ?? [],
          {
            month: resolveMonth(month),
            since: since_month ? resolveMonth(since_month) : null,
            iso,
          },
        );
        return result(
          renderCategoryReport(report, { includeIds: include_ids }),
          report,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
