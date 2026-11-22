import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, CategoryGroup, SaveCategory, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import { handleError, result, scopeDeniedError } from "../format";
import type { Props } from "../ynab-auth";

// ---- Input + Result types

export const CategoryChangeSchema = z.object({
  category_id: z.string(),
  name: z.string().trim().min(1).optional().describe("The new name."),
  category_group_id: z
    .string()
    .optional()
    .describe("Move the category to this group. Find group ids with get_month and include_ids."),
});
export type CategoryChange = z.infer<typeof CategoryChangeSchema>;

const ResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    category_id: z.string(),
    before_name: z.string(),
    after_name: z.string(),
    before_group: z.string(),
    after_group: z.string(),
  }),
  z.object({ ok: z.literal(false), category_id: z.string(), error: z.string() }),
]);
export type CategoryChangeResult = z.infer<typeof ResultSchema>;

export const UpdateCategoriesResultSchema = z.object({
  results: z.array(ResultSchema),
});
export type UpdateCategoriesResult = z.infer<typeof UpdateCategoriesResultSchema>;

// ---- Compute (pure)

// YNAB accepts a duplicate name, but then the two can't be told apart when
// categorizing, so both create and rename refuse one.
export const nameTakenError = (
  name: string,
  groups: CategoryGroup[],
  exceptId?: string,
): string | null => {
  const want = name.trim().toLowerCase();
  for (const g of groups) {
    if (g.deleted) continue;
    const c = (g.categories ?? []).find(
      (c) => !c.deleted && c.id !== exceptId && c.name.trim().toLowerCase() === want,
    );
    if (c) {
      const hidden = c.hidden || g.hidden ? ", hidden" : "";
      return `Category "${c.name}" (id ${c.id}, in ${g.name}${hidden}) already has that name.`;
    }
  }
  return null;
};

export const groupError = (groupId: string, groups: CategoryGroup[]): string | null => {
  if (groups.some((g) => g.id === groupId && !g.deleted)) return null;
  const live = groups.filter((g) => !g.deleted).map((g) => `${g.name} (id ${g.id})`);
  return `No such category group. Groups: ${live.join(", ")}.`;
};

// Credit Card Payments categories are tied to their card; YNAB's `internal`
// flag can't identify that group, since template groups carry it too.
const isCardPaymentGroup = (g: CategoryGroup | undefined) => g?.name === "Credit Card Payments";

export const changeBody = (
  change: CategoryChange,
  groups: CategoryGroup[],
): { body: SaveCategory } | { error: string } => {
  const group = groups.find((g) => (g.categories ?? []).some((c) => c.id === change.category_id));
  const category = group?.categories?.find((c) => c.id === change.category_id);
  if (!group || !category || category.deleted) return { error: "No such category." };
  if (category.internal || isCardPaymentGroup(group)) {
    return { error: `"${category.name}" is managed by YNAB and can't be renamed or moved.` };
  }
  const body: SaveCategory = {};
  if (change.name !== undefined && change.name !== category.name) {
    const taken = nameTakenError(change.name, groups, category.id);
    if (taken) return { error: taken };
    body.name = change.name;
  }
  if (change.category_group_id !== undefined && change.category_group_id !== group.id) {
    const bad = groupError(change.category_group_id, groups);
    if (bad) return { error: bad };
    body.category_group_id = change.category_group_id;
  }
  if (Object.keys(body).length === 0) return { error: "Nothing to change." };
  return { body };
};

// Moves a category within the local copy so later changes in the batch see it.
const place = (groups: CategoryGroup[], updated: Category): CategoryGroup[] =>
  groups.map((g) => {
    const rest = (g.categories ?? []).filter((c) => c.id !== updated.id);
    return { ...g, categories: g.id === updated.category_group_id ? [...rest, updated] : rest };
  });

// ---- Effectful: one PATCH per change, in input order, never short-circuit

const errorMessage = (e: unknown) =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

export const updateCategories = async (
  client: YnabClient,
  planId: string,
  changes: CategoryChange[],
): Promise<UpdateCategoriesResult> => {
  let groups = (await client.listCategories(planId)).data.category_groups;
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const results: CategoryChangeResult[] = [];
  for (const change of changes) {
    const planned = changeBody(change, groups);
    if ("error" in planned) {
      results.push({ ok: false, category_id: change.category_id, error: planned.error });
      continue;
    }
    const before = groups.flatMap((g) => g.categories ?? []).find((c) => c.id === change.category_id)!;
    try {
      const { data } = await client.updateCategory(planId, change.category_id, planned.body);
      results.push({
        ok: true,
        category_id: change.category_id,
        before_name: before.name,
        after_name: data.category.name,
        before_group: groupName(before.category_group_id),
        after_group: groupName(data.category.category_group_id),
      });
      groups = place(groups, data.category);
    } catch (e) {
      results.push({ ok: false, category_id: change.category_id, error: errorMessage(e) });
    }
  }
  return { results };
};

// ---- Render (pure)

export const renderUpdateCategories = (out: UpdateCategoriesResult): string => {
  const n = out.results.length;
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = n - okCount;
  const errs = errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : "";
  const header = `## Updated ${okCount} / ${n} categor${n === 1 ? "y" : "ies"}${errs}`;
  const lines = out.results.map((r) => {
    if (!r.ok) return `- [error] ${r.category_id}: ${r.error}`;
    const parts: string[] = [];
    if (r.before_name !== r.after_name) parts.push(`"${r.before_name}" → "${r.after_name}"`);
    else parts.push(`"${r.after_name}"`);
    if (r.before_group !== r.after_group) parts.push(`moved ${r.before_group} → ${r.after_group}`);
    return `- [ok] ${parts.join(", ")} — id ${r.category_id}`;
  });
  return [header, ...lines].join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Rename categories or move them to another category group. Find category and group ids " +
  "with get_month and include_ids. Refuses a name another category already has, and " +
  "YNAB's own categories (Ready to Assign, Uncategorized, credit card payments). A failed " +
  "change doesn't stop the rest, and the response reports each one. This tool can't hide, " +
  "unhide, or delete a category, and can't change goals (use set_category_goals): YNAB's " +
  "API has no way to hide or delete one, so the user does that in YNAB. Requires write " +
  "access; a read-only connection must be reconnected to use this tool.";

export const registerUpdateCategories = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "update_categories",
    {
      title: "Update Categories",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        changes: z.array(CategoryChangeSchema).min(1).max(50),
      },
    },
    async ({ plan_id, changes }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const out = await updateCategories(getClient(), plan_id, changes);
        return result(renderUpdateCategories(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
