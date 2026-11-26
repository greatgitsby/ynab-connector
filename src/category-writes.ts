import { z } from "zod";
import type { GoalView } from "./goals";
import { normalizeName } from "./resolve";
import { dateParam } from "./schemas";
import {
  GOAL_FREQUENCIES,
  type CategoryGroup,
  type SaveCategoryGoal,
} from "./ynab";

export const GoalFieldsSchema = z.object({
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
export type GoalFields = z.infer<typeof GoalFieldsSchema>;

export const goalFields = (
  fields: GoalFields,
  goal: GoalView | null,
): { body: SaveCategoryGoal } | { error: string } => {
  if (fields.goal_frequency && fields.goal_target === undefined) {
    return { error: "goal_frequency needs goal_target." };
  }
  if (fields.goal_frequency && fields.goal_target_date !== undefined) {
    return { error: "goal_frequency can't be combined with goal_target_date." };
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

// YNAB accepts a duplicate name, but then the two can't be told apart when
// categorizing, so both create and rename refuse one. Names compare the way
// the resolver matches them, or it would call the pair ambiguous.
export const nameTakenError = (
  name: string,
  groups: CategoryGroup[],
  exceptId?: string,
): string | null => {
  const want = normalizeName(name);
  for (const g of groups) {
    if (g.deleted) continue;
    const c = (g.categories ?? []).find(
      (c) => !c.deleted && c.id !== exceptId && normalizeName(c.name) === want,
    );
    if (c) {
      const hidden = c.hidden || g.hidden ? ", hidden" : "";
      return `Category "${c.name}" (id ${c.id}, in ${g.name}${hidden}) already has that name.`;
    }
  }
  return null;
};

export const groupError = (
  groupId: string,
  groups: CategoryGroup[],
): string | null => {
  if (groups.some((g) => g.id === groupId && !g.deleted)) return null;
  const live = groups
    .filter((g) => !g.deleted)
    .map((g) => `${g.name} (id ${g.id})`);
  return `No such category group. Groups: ${live.join(", ")}.`;
};
