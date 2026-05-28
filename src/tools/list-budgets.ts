import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Budget, YnabClient } from "../ynab";
import { text, handleError } from "../format";

// ---- Result type

export interface BudgetList {
  budgets: Budget[];
}

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

const fmtBudgetLine = (b: Budget): string =>
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
    },
    async ({ include_archived }) => {
      try {
        const { data } = await getClient().listBudgets();
        const list = computeBudgetList(data.budgets, {
          includeArchived: include_archived,
        });
        return text(renderBudgetList(list));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
