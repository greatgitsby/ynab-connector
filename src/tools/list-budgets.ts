import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Budget, YnabClient } from "../ynab";
import { result, handleError } from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see ADR 0002).
// Budgets carry no top-level milliunit money — currency lives per-budget in
// currency_format — so this view needs no separate iso field.

const BudgetSchema = z.object({
  id: z.string(),
  name: z.string(),
  last_modified_on: z.string(),
  first_month: z.string(),
  last_month: z.string(),
  currency_format: z
    .object({ iso_code: z.string(), decimal_digits: z.number().int() })
    .optional(),
});

export const BudgetListSchema = z.object({
  budgets: z.array(BudgetSchema),
});
export type BudgetList = z.infer<typeof BudgetListSchema>;

// ---- Compute (pure)

export interface ComputeOpts {
  includeArchived: boolean;
}

export const computeBudgetList = (
  fetched: Budget[],
  opts: ComputeOpts,
): BudgetList => {
  return {
    budgets: fetched.filter(
      (b) => opts.includeArchived || !/\(Archived/.test(b.name),
    ),
  };
};

// ---- Render (pure)

const fmtBudgetLine = (b: BudgetList["budgets"][number]): string =>
  `- ${b.name} (id: ${b.id}) — ${b.currency_format?.iso_code ?? "USD"}, last modified ${b.last_modified_on}`;

export const renderBudgetList = (list: BudgetList): string => {
  if (!list.budgets.length) return "No budgets found.";
  return list.budgets.map(fmtBudgetLine).join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "List YNAB budgets accessible with the configured token. Returns id, name, currency, and last-modified date. Archived budgets (name contains '(Archived') are hidden by default.";

export const registerListBudgets = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_budgets",
    {
      title: "List Budgets",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        include_archived: z.boolean().optional().default(false),
      },
      outputSchema: BudgetListSchema.shape,
    },
    async ({ include_archived }) => {
      try {
        const { data } = await getClient().listBudgets();
        const list = computeBudgetList(data.budgets, {
          includeArchived: include_archived,
        });
        return result(renderBudgetList(list), list);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
