import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Plan, YnabClient } from "../ynab";
import { PlanSchema } from "../wire";
import { result, handleError } from "../format";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

export const PlanListSchema = z.object({
  // Most recently modified first.
  plans: z.array(PlanSchema),
});
export type PlanList = z.infer<typeof PlanListSchema>;

// ---- Compute (pure)

export const computePlanList = (fetched: Plan[]): PlanList => ({
  plans: [...fetched].sort((a, b) =>
    (b.last_modified_on ?? "").localeCompare(a.last_modified_on ?? ""),
  ),
});

// ---- Render (pure)

export const renderPlanList = (list: PlanList): string => {
  if (!list.plans.length) return "No plans found.";
  return list.plans
    .map(
      (p) =>
        `- ${p.name} (${p.currency_format?.iso_code ?? "USD"}, ${p.first_month?.slice(0, 7)} to ${p.last_month?.slice(0, 7)}, last modified ${p.last_modified_on?.slice(0, 10)}) — id ${p.id}`,
    )
    .join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "List the YNAB plans this connection can see, most recently modified " +
  "first, with id, currency, month range, and last-modified date. YNAB " +
  "renames archived plans to include \"(Archived on …)\".";

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
      inputSchema: {},
      outputSchema: PlanListSchema.shape,
    },
    async () => {
      try {
        const { data } = await getClient().listPlans();
        const list = computePlanList(data.plans);
        return result(renderPlanList(list), list);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
