import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Category, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import {
  fmtMoney,
  handleError,
  result,
  scopeDeniedError,
} from "../format";
import type { Props } from "../ynab-auth";

// ---- Input + Result types

export interface AssignMoveInput {
  month: string;
  category_id: string;
  set_budgeted_milliunits: number;
}

export interface AssignMoveOk {
  ok: true;
  month: string;
  category_id: string;
  category_name: string;
  before_budgeted: number;
  after_budgeted: number;
  balance: number;
}

export interface AssignMoveError {
  ok: false;
  month: string;
  category_id: string;
  error: string;
}

export type AssignMoveResult = AssignMoveOk | AssignMoveError;

export interface AssignToCategoriesResult {
  results: AssignMoveResult[];
}

// ---- Compute (effectful: one PATCH per move, in input order, never short-circuit)

export const applyAssignToCategories = async (
  client: YnabClient,
  budgetId: string,
  moves: AssignMoveInput[],
): Promise<AssignToCategoriesResult> => {
  const results: AssignMoveResult[] = [];
  for (const move of moves) {
    try {
      // Read current value first so we can report before/after in the
      // summary. The read is cheap (single category endpoint) and isolated
      // per-move — if it fails, we record the failure and continue.
      const before = await client.getCategory(budgetId, move.category_id);
      const updated = await client.updateCategoryMonth(
        budgetId,
        move.month,
        move.category_id,
        { budgeted: move.set_budgeted_milliunits },
      );
      const cat = updated.data.category;
      results.push({
        ok: true,
        month: move.month,
        category_id: move.category_id,
        category_name: cat.name,
        before_budgeted: before.data.category.budgeted,
        after_budgeted: cat.budgeted,
        balance: cat.balance,
      });
    } catch (e) {
      const message =
        e instanceof YnabError
          ? `YNAB ${e.status}: ${e.body}`
          : e instanceof Error
            ? e.message
            : String(e);
      results.push({
        ok: false,
        month: move.month,
        category_id: move.category_id,
        error: message,
      });
    }
  }
  return { results };
};

// ---- Render (pure)

export const renderAssignToCategoriesResult = (
  out: AssignToCategoriesResult,
): string => {
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = out.results.length - okCount;
  const header = `## Reassigned ${okCount} / ${out.results.length} categor${out.results.length === 1 ? "y" : "ies"}${errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : ""}`;
  const lines = out.results.map((r) => {
    if (r.ok) {
      const arrow = r.before_budgeted === r.after_budgeted ? "=" : "→";
      return `- [ok] ${r.month} ${r.category_name}: ${fmtMoney(r.before_budgeted)} ${arrow} ${fmtMoney(r.after_budgeted)} (balance ${fmtMoney(r.balance)}) — id ${r.category_id}`;
    }
    return `- [error] ${r.month} ${r.category_id}: ${r.error}`;
  });
  return [header, ...lines].join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Set per-month `budgeted` amounts on one or more categories (absolute " +
  "set, in milliunits). Use this to reassign money between categories or " +
  "to fund a category from Ready to Assign. Each move is the literal new " +
  "value, not a delta — read `get_month` or `triage_inbox` first to know " +
  "the current values and compute new totals. Best-effort per item: " +
  "failures don't stop subsequent moves; the response reports per-item " +
  "outcomes. Requires write access — connections granted read-only must " +
  "be reconnected to enable this tool.";

export const registerAssignToCategories = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "assign_to_categories",
    {
      title: "Assign to Categories",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        budget_id: z.string(),
        moves: z
          .array(
            z.object({
              month: z
                .string()
                .regex(/^(\d{4}-\d{2}-01|current)$/, {
                  message: "month must be YYYY-MM-01 or 'current'",
                }),
              category_id: z.string(),
              set_budgeted_milliunits: z.number().int(),
            }),
          )
          .min(1),
      },
    },
    async ({ budget_id, moves }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const out = await applyAssignToCategories(getClient(), budget_id, moves);
        return result(renderAssignToCategoriesResult(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};

// Re-export for the test's convenience.
export type { Category };
