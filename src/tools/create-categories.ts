import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, CategoryGroup, NewCategory, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import { handleError, result, scopeDeniedError } from "../format";
import { interpretGoal } from "../goals";
import { resolveMonth } from "../month-window";
import type { Props } from "../ynab-auth";
import { GoalChangeSchema, goalBody } from "./set-category-goals";
import { groupError, nameTakenError } from "./update-categories";

// ---- Input + Result types

export const NewCategorySchema = GoalChangeSchema.omit({ category_id: true, remove_goal: true }).extend({
  category_group_id: z
    .string()
    .describe("The group to create it in. Find group ids with get_month and include_ids."),
  name: z.string().trim().min(1),
});
export type NewCategoryInput = z.infer<typeof NewCategorySchema>;

const ResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    category_id: z.string(),
    name: z.string(),
    group: z.string(),
    // GoalView label; null means no goal.
    goal: z.string().nullable(),
  }),
  z.object({ ok: z.literal(false), name: z.string(), error: z.string() }),
]);
export type CreateCategoryResult = z.infer<typeof ResultSchema>;

export const CreateCategoriesResultSchema = z.object({
  results: z.array(ResultSchema),
});
export type CreateCategoriesResult = z.infer<typeof CreateCategoriesResultSchema>;

// ---- Compute (pure): the POST body, or why not to send it

export const newCategoryBody = (
  input: NewCategoryInput,
  groups: CategoryGroup[],
  refMonth: string,
): { body: NewCategory } | { error: string } => {
  const { category_group_id, name, ...goal } = input;
  const badGroup = groupError(category_group_id, groups);
  if (badGroup) return { error: badGroup };
  const taken = nameTakenError(name, groups);
  if (taken) return { error: taken };
  const body: NewCategory = { name, category_group_id };
  if (Object.values(goal).every((v) => v === undefined)) return { body };
  if (goal.goal_target === undefined) return { error: "A goal needs goal_target." };
  // A new category has no goal, so the goal rules are those for a goalless one.
  const goalless = { name, deleted: false, internal: false, goal_type: null } as Category;
  const planned = goalBody({ category_id: "", ...goal }, goalless, refMonth);
  if ("error" in planned) return planned;
  return { body: { ...body, ...planned.body } };
};

// ---- Effectful: one POST per category, in input order, never short-circuit

const errorMessage = (e: unknown) =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

export const createCategories = async (
  client: YnabClient,
  planId: string,
  inputs: NewCategoryInput[],
): Promise<CreateCategoriesResult> => {
  const [iso, { data }] = await Promise.all([client.planIso(planId), client.listCategories(planId)]);
  const refMonth = resolveMonth("current");
  let groups = data.category_groups;
  const results: CreateCategoryResult[] = [];
  for (const input of inputs) {
    const planned = newCategoryBody(input, groups, refMonth);
    if ("error" in planned) {
      results.push({ ok: false, name: input.name, error: planned.error });
      continue;
    }
    try {
      const { category } = (await client.createCategory(planId, planned.body)).data;
      const group = groups.find((g) => g.id === category.category_group_id);
      results.push({
        ok: true,
        category_id: category.id,
        name: category.name,
        group: group?.name ?? category.category_group_id,
        goal: interpretGoal(category, refMonth, iso)?.label ?? null,
      });
      // Later items in the batch see the new name.
      groups = groups.map((g) =>
        g === group ? { ...g, categories: [...(g.categories ?? []), category] } : g,
      );
    } catch (e) {
      results.push({ ok: false, name: input.name, error: errorMessage(e) });
    }
  }
  return { results };
};

// ---- Render (pure)

export const renderCreateCategories = (out: CreateCategoriesResult): string => {
  const n = out.results.length;
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = n - okCount;
  const errs = errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : "";
  const header = `## Created ${okCount} / ${n} categor${n === 1 ? "y" : "ies"}${errs}`;
  const lines = out.results.map((r) =>
    r.ok
      ? `- [ok] "${r.name}" in ${r.group}${r.goal ? `, goal ${r.goal}` : ""} — id ${r.category_id}`
      : `- [error] "${r.name}": ${r.error}`,
  );
  return [header, ...lines].join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Create one or more categories in existing category groups, each optionally with a goal " +
  "(YNAB calls it a target). goal_target alone makes a monthly 'set aside' goal; " +
  "goal_frequency makes it repeat monthly, weekly, or yearly. Amounts are milliunits. Find " +
  "group ids with get_month and include_ids. Refuses a name another category already has, " +
  "including a hidden one (the user unhides that in YNAB instead). YNAB's API can't delete " +
  "a category, so a mistaken one must be renamed with update_categories or deleted in YNAB. " +
  "A failed item doesn't stop the rest, and the response reports each one. Requires write " +
  "access; a read-only connection must be reconnected to use this tool.";

export const registerCreateCategories = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "create_categories",
    {
      title: "Create Categories",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        categories: z.array(NewCategorySchema).min(1).max(50),
      },
    },
    async ({ plan_id, categories }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const out = await createCategories(getClient(), plan_id, categories);
        return result(renderCreateCategories(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
