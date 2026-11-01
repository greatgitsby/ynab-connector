import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Plan, YnabClient } from "../ynab";
import { result, handleError } from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see docs/internals/structured-output.md).
// Plans carry no top-level milliunit money — currency lives per-plan in
// currency_format — so this view needs no separate iso field.

const PlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  last_modified_on: z.string(),
  first_month: z.string(),
  last_month: z.string(),
  currency_format: z
    .object({ iso_code: z.string(), decimal_digits: z.number().int() })
    .optional(),
});

export const PlanListSchema = z.object({
  plans: z.array(PlanSchema),
});
export type PlanList = z.infer<typeof PlanListSchema>;

// ---- Compute (pure)

export interface ComputeOpts {
  includeArchived: boolean;
}

export const computePlanList = (
  fetched: Plan[],
  opts: ComputeOpts,
): PlanList => {
  return {
    plans: fetched.filter(
      (b) => opts.includeArchived || !/\(Archived/.test(b.name),
    ),
  };
};

// ---- Render (pure)

const fmtPlanLine = (b: PlanList["plans"][number]): string =>
  `- ${b.name} (id: ${b.id}) — ${b.currency_format?.iso_code ?? "USD"}, last modified ${b.last_modified_on}`;

export const renderPlanList = (list: PlanList): string => {
  if (!list.plans.length) return "No plans found.";
  return list.plans.map(fmtPlanLine).join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "List YNAB plans accessible with the configured token. Returns id, name, currency, and last-modified date. Archived plans (name contains '(Archived') are hidden by default.";

export const registerListPlans = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_plans",
    {
      title: "List Plans",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        include_archived: z.boolean().optional().default(false),
      },
      outputSchema: PlanListSchema.shape,
    },
    async ({ include_archived }) => {
      try {
        const { data } = await getClient().listPlans();
        const list = computePlanList(data.plans, {
          includeArchived: include_archived,
        });
        return result(renderPlanList(list), list);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
