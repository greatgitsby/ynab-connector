import { z } from "zod";
import { dateParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, SaveCategoryGoal, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import { fmtMoney, handleError, result, scopeDeniedError } from "../format";
import { interpretGoal } from "../goals";
import { resolveMonth } from "../month-window";
import type { Props } from "../ynab-auth";

// ---- Input + Result types

const GOAL_FREQUENCIES = ["monthly", "weekly", "yearly"] as const;

export const GoalChangeSchema = z.object({
  category_id: z.string(),
  remove_goal: z
    .boolean()
    .optional()
    .describe(
      "true removes the category's goal. Can't be combined with the other fields.",
    ),
  goal_target: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The goal amount in milliunits."),
  goal_frequency: z
    .enum(GOAL_FREQUENCIES)
    .optional()
    .describe(
      "Replace the goal with a 'Plan Your Spending' goal of goal_target that repeats at this " +
        "frequency. Needs goal_target; can't be combined with goal_target_date. Leave out to " +
        "keep the current goal's type and cadence.",
    ),
  goal_target_date: dateParam
    .nullable()
    .optional()
    .describe("Due date, YYYY-MM-DD. null clears it."),
  goal_needs_whole_amount: z
    .boolean()
    .optional()
    .describe(
      "'Plan Your Spending' goals only. true sets aside the full amount each period; false " +
        "refills up to it, counting money already there.",
    ),
});
export type GoalChange = z.infer<typeof GoalChangeSchema>;

const ResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    category_id: z.string(),
    category_name: z.string(),
    // The PATCH body sent, or to be sent in a preview.
    request: z.object({
      goal_target: z.number().int().nullable().optional(),
      goal_target_date: z.string().nullable().optional(),
      goal_needs_whole_amount: z.boolean().optional(),
      goal_frequency: z.enum(GOAL_FREQUENCIES).optional(),
    }),
    // GoalView labels; null means no goal.
    before: z.string().nullable(),
    // Present once applied.
    after: z.string().nullable().optional(),
  }),
  z.object({
    ok: z.literal(false),
    category_id: z.string(),
    error: z.string(),
  }),
]);
export type GoalChangeResult = z.infer<typeof ResultSchema>;

export const SetCategoryGoalsResultSchema = z.object({
  iso: z.string(),
  applied: z.boolean(),
  results: z.array(ResultSchema),
});
export type SetCategoryGoalsResult = z.infer<
  typeof SetCategoryGoalsResultSchema
>;

// ---- Compute (pure): the PATCH body for one change, or why not to send it

export const goalBody = (
  change: GoalChange,
  category: Category | undefined,
  refMonth: string,
): { body: SaveCategoryGoal } | { error: string } => {
  if (!category || category.deleted) return { error: "No such category." };
  if (category.internal)
    return {
      error: `"${category.name}" is internal to YNAB and can't have a goal.`,
    };
  const { category_id: _, remove_goal, ...fields } = change;
  const goal = interpretGoal(category, refMonth);
  const setsSomething = Object.values(fields).some((v) => v !== undefined);

  if (remove_goal) {
    if (setsSomething)
      return { error: "remove_goal can't be combined with other fields." };
    if (!goal) return { error: `"${category.name}" has no goal to remove.` };
    return { body: { goal_target: null } };
  }
  if (!setsSomething) return { error: "Nothing to change." };
  if (fields.goal_frequency && fields.goal_target === undefined) {
    return { error: "goal_frequency needs goal_target." };
  }
  if (fields.goal_frequency && fields.goal_target_date !== undefined) {
    return { error: "goal_frequency can't be combined with goal_target_date." };
  }
  if (!goal && fields.goal_target === undefined) {
    return {
      error: `"${category.name}" has no goal; give goal_target to create one.`,
    };
  }
  // A new goal or a goal_frequency makes a NEED goal. YNAB stores the flag
  // on any other type without complaint, where it means nothing.
  const becomesNeed = !goal || !!fields.goal_frequency || goal.type === "NEED";
  if (fields.goal_needs_whole_amount !== undefined && !becomesNeed) {
    return {
      error:
        "goal_needs_whole_amount applies only to 'Plan Your Spending' goals.",
    };
  }
  const body: SaveCategoryGoal = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) Object.assign(body, { [k]: v });
  }
  return { body };
};

// ---- Effectful: one PATCH per change, in input order, never short-circuit

const errorMessage = (e: unknown) =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

export const setCategoryGoals = async (
  client: YnabClient,
  planId: string,
  changes: GoalChange[],
  apply: boolean,
): Promise<SetCategoryGoalsResult> => {
  const [iso, { data }] = await Promise.all([
    client.planIso(planId),
    client.listCategories(planId),
  ]);
  const refMonth = resolveMonth("current");
  const byId = new Map(
    data.category_groups
      .flatMap((g) => g.categories ?? [])
      .map((c) => [c.id, c]),
  );
  const label = (c: Category) => interpretGoal(c, refMonth, iso)?.label ?? null;

  const results: GoalChangeResult[] = [];
  for (const change of changes) {
    const category = byId.get(change.category_id);
    const planned = goalBody(change, category, refMonth);
    if ("error" in planned) {
      results.push({
        ok: false,
        category_id: change.category_id,
        error: planned.error,
      });
      continue;
    }
    const ok = {
      ok: true as const,
      category_id: change.category_id,
      category_name: category!.name,
      request: planned.body,
      before: label(category!),
    };
    if (!apply) {
      results.push(ok);
      continue;
    }
    try {
      const updated = await client.updateCategory(
        planId,
        change.category_id,
        planned.body,
      );
      results.push({ ...ok, after: label(updated.data.category) });
    } catch (e) {
      results.push({
        ok: false,
        category_id: change.category_id,
        error: errorMessage(e),
      });
    }
  }
  return { iso, applied: apply, results };
};

// ---- Render (pure)

const describeRequest = (r: SaveCategoryGoal, iso: string): string => {
  if (r.goal_target === null) return "remove the goal";
  const parts: string[] = [];
  if (r.goal_target != null)
    parts.push(`target ${fmtMoney(r.goal_target, iso)}`);
  if (r.goal_frequency) parts.push(`repeating ${r.goal_frequency}`);
  if (r.goal_target_date === null) parts.push("no due date");
  else if (r.goal_target_date) parts.push(`due ${r.goal_target_date}`);
  if (r.goal_needs_whole_amount === true)
    parts.push("set aside the full amount each period");
  if (r.goal_needs_whole_amount === false)
    parts.push("refill up to the amount");
  return parts.join(", ");
};

export const renderSetCategoryGoals = (out: SetCategoryGoalsResult): string => {
  const n = out.results.length;
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = n - okCount;
  const noun = `categor${n === 1 ? "y" : "ies"}`;
  const errs = errCount
    ? ` (${errCount} error${errCount === 1 ? "" : "s"})`
    : "";
  const header = out.applied
    ? `## Changed goals on ${okCount} / ${n} ${noun}${errs}`
    : `## Preview: change goals on ${n} ${noun}${errs} (nothing changed yet)`;
  const lines = out.results.map((r) => {
    if (!r.ok) return `- [error] ${r.category_id}: ${r.error}`;
    const before = r.before ?? "no goal";
    const change = out.applied
      ? `${before} → ${r.after ?? "no goal"}`
      : `${before}; will ${describeRequest(r.request, out.iso)}`;
    return `- ${out.applied ? "[ok] " : ""}${r.category_name}: ${change} — id ${r.category_id}`;
  });
  const footer =
    !out.applied && okCount
      ? [
          "",
          "Call set_category_goals again with the same changes and apply: true to make them.",
        ]
      : [];
  return [header, ...lines, ...footer].join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Create, change, or remove goals (YNAB calls them targets) on one or more categories. " +
  "A change with goal_target alone keeps the goal's type and cadence and sets a new amount; " +
  "on a category without a goal it creates a monthly 'set aside' goal. goal_frequency " +
  "replaces the goal with a monthly, weekly, or yearly one. remove_goal deletes the goal; " +
  "YNAB's API can only recreate monthly, weekly, or yearly 'Plan Your Spending' goals, so a " +
  "removed savings-balance or every-N-months goal can only be rebuilt in YNAB. By default it " +
  "only previews: show the preview to the user, then call again with apply: true. Amounts " +
  "are milliunits. Find category ids and current goals with get_month. This tool can't " +
  "hide or unhide a category: YNAB's API has no way to, so the user does it in YNAB " +
  "(category menu, Hide). Requires write access; a read-only connection must be " +
  "reconnected to use this tool.";

export const registerSetCategoryGoals = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "set_category_goals",
    {
      title: "Set Category Goals",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        changes: z.array(GoalChangeSchema).min(1).max(50),
        apply: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "false (default) previews without changing anything; true makes the changes.",
          ),
      },
    },
    async ({ plan_id, changes, apply }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const out = await setCategoryGoals(
          getClient(),
          plan_id,
          changes,
          apply,
        );
        return result(renderSetCategoryGoals(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
