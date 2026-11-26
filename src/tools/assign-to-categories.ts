import { z } from "zod";
import { monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, MonthDetail, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import {
  fmtMoney,
  handleError,
  result,
  scopeDeniedError,
  text,
} from "../format";
import type { Props } from "../ynab-auth";
import { interpretGoal } from "../goals";
import { isSpendingCategory } from "../predicates";
import { resolveAll, resolveOne, type Named } from "../resolve";

// ---- Input + Result types

export type AssignOp = { set: number } | { add: number } | { fundGoal: true };

export interface AssignMoveInput {
  month: string;
  // An id or a name ("Groceries", "Group: Name").
  category: string;
  op: AssignOp;
}

export interface AssignMoveOk {
  ok: true;
  month: string;
  category_id: string;
  category_name: string;
  before_budgeted: number;
  after_budgeted: number;
  change: number;
  // Available after the change. Projected on a dry run.
  balance: number;
}

export interface AssignMoveError {
  ok: false;
  month: string;
  category: string;
  error: string;
}

export type AssignMoveResult = AssignMoveOk | AssignMoveError;

export interface AssignToCategoriesResult {
  dry_run: boolean;
  results: AssignMoveResult[];
  // Per month touched. `after` is re-read from YNAB, or projected on a dry run.
  ready_to_assign: { month: string; before: number; after: number | null }[];
}

// ---- Compute (pure)

const monthRefs = (m: MonthDetail): Named[] =>
  m.categories
    .filter((c) => !c.deleted && !c.internal)
    .map((c) => ({
      id: c.id,
      name: c.name,
      group: c.category_group_name,
      inactive: c.hidden,
    }));

// Every underfunded goal in the month except the `except` names, as fund-goal
// moves. A name in `except` that matches nothing is an error: the caller
// meant to protect something, and guessing wrong would spend it.
export const expandFundUnderfunded = (
  monthKey: string,
  detail: MonthDetail,
  except: string[],
  alreadyMoved: ReadonlySet<string>,
): { moves: AssignMoveInput[] } | { error: string } => {
  const refs = monthRefs(detail);
  const skip = new Set<string>();
  for (const ref of except) {
    const r = resolveAll(refs, ref, "category");
    if (!r.ok) return { error: `fund_underfunded.except: ${r.error}` };
    for (const m of r.matches) skip.add(m.id);
  }
  const moves = detail.categories
    .filter(isSpendingCategory)
    .filter((c) => !skip.has(c.id) && !alreadyMoved.has(c.id))
    .filter((c) => {
      const g = interpretGoal(c, detail.month);
      return !!g && g.underfundedThisMonth > 0 && !g.snoozed;
    })
    .map((c) => ({
      month: monthKey,
      category: c.id,
      op: { fundGoal: true } as const,
    }));
  return { moves };
};

// Turns moves into before/after amounts against the months' current state.
// Moves apply in order, so a second move on one category sees the first.
export const planMoves = (
  moves: AssignMoveInput[],
  months: ReadonlyMap<string, MonthDetail>,
): AssignMoveResult[] => {
  const working = new Map<string, Category>();
  return moves.map((move): AssignMoveResult => {
    const detail = months.get(move.month);
    const fail = (error: string): AssignMoveError => ({
      ok: false,
      month: move.month,
      category: move.category,
      error,
    });
    if (!detail) return fail("Month not loaded.");
    const r = resolveOne(monthRefs(detail), move.category, "category");
    if (!r.ok) return fail(r.error);
    const key = `${detail.month}|${r.matches[0].id}`;
    const c =
      working.get(key) ??
      detail.categories.find((x) => x.id === r.matches[0].id)!;
    let after: number;
    if ("set" in move.op) after = move.op.set;
    else if ("add" in move.op) after = c.budgeted + move.op.add;
    else {
      const g = interpretGoal(c, detail.month);
      if (!g) return fail(`${c.name} has no goal to fund.`);
      after = c.budgeted + (g.snoozed ? 0 : g.underfundedThisMonth);
    }
    const change = after - c.budgeted;
    // A category's goal shortfall shrinks one for one as it gets money.
    const next: Category = {
      ...c,
      budgeted: after,
      balance: c.balance + change,
      goal_under_funded:
        c.goal_under_funded == null
          ? c.goal_under_funded
          : Math.max(0, c.goal_under_funded - change),
    };
    working.set(key, next);
    return {
      ok: true,
      month: detail.month,
      category_id: c.id,
      category_name: c.name,
      before_budgeted: c.budgeted,
      after_budgeted: after,
      change,
      balance: next.balance,
    };
  });
};

// ---- Effectful: read each month, plan, PATCH each change, re-read

const errorMessage = (e: unknown): string =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

export interface AssignRequest {
  moves: AssignMoveInput[];
  fundUnderfunded?: { month: string; except: string[] };
  dryRun: boolean;
}

export const applyAssignToCategories = async (
  client: Pick<YnabClient, "getMonth" | "updateCategoryMonth">,
  planId: string,
  req: AssignRequest,
): Promise<AssignToCategoriesResult | { error: string }> => {
  const keys = [
    ...new Set([
      ...req.moves.map((m) => m.month),
      ...(req.fundUnderfunded ? [req.fundUnderfunded.month] : []),
    ]),
  ];
  const months = new Map<string, MonthDetail>();
  await Promise.all(
    keys.map(async (k) =>
      months.set(k, (await client.getMonth(planId, k)).data.month),
    ),
  );

  let moves = req.moves;
  if (req.fundUnderfunded) {
    const { month, except } = req.fundUnderfunded;
    const detail = months.get(month)!;
    const explicit = planMoves(req.moves, months)
      .filter((r): r is AssignMoveOk => r.ok && r.month === detail.month)
      .map((r) => r.category_id);
    const expanded = expandFundUnderfunded(
      month,
      detail,
      except,
      new Set(explicit),
    );
    if ("error" in expanded) return expanded;
    moves = [...req.moves, ...expanded.moves];
  }

  const planned = planMoves(moves, months);
  const results: AssignMoveResult[] = [];
  for (const p of planned) {
    if (!p.ok || req.dryRun || p.change === 0) {
      results.push(p);
      continue;
    }
    try {
      const { data } = await client.updateCategoryMonth(
        planId,
        p.month,
        p.category_id,
        {
          budgeted: p.after_budgeted,
        },
      );
      results.push({
        ...p,
        after_budgeted: data.category.budgeted,
        balance: data.category.balance,
      });
    } catch (e) {
      results.push({
        ok: false,
        month: p.month,
        category: p.category_id,
        error: errorMessage(e),
      });
    }
  }

  // "current" and its YYYY-MM-01 name are one month.
  const distinct = [
    ...new Map([...months.values()].map((m) => [m.month, m])).values(),
  ];
  const ready_to_assign = await Promise.all(
    distinct.map(async (m) => {
      const spent = results
        .filter((r): r is AssignMoveOk => r.ok && r.month === m.month)
        .reduce((a, r) => a + r.change, 0);
      if (req.dryRun) {
        return {
          month: m.month,
          before: m.to_be_budgeted,
          after: m.to_be_budgeted - spent,
        };
      }
      try {
        const fresh = await client.getMonth(planId, m.month);
        return {
          month: m.month,
          before: m.to_be_budgeted,
          after: fresh.data.month.to_be_budgeted,
        };
      } catch {
        return { month: m.month, before: m.to_be_budgeted, after: null };
      }
    }),
  );
  return { dry_run: req.dryRun, results, ready_to_assign };
};

// ---- Render (pure)

export const renderAssignToCategoriesResult = (
  out: AssignToCategoriesResult,
  iso: string,
): string => {
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = out.results.length - okCount;
  const verb = out.dry_run ? "Would reassign" : "Reassigned";
  const n = out.results.length;
  const header = `## ${verb} ${okCount} / ${n} categor${n === 1 ? "y" : "ies"}${errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : ""}${out.dry_run ? " — dry run, nothing written" : ""}`;
  const lines = out.results.map((r) => {
    if (r.ok) {
      const arrow = r.change === 0 ? "=" : "→";
      const delta = r.change
        ? ` (${r.change > 0 ? "+" : ""}${fmtMoney(r.change, iso)})`
        : "";
      return `- [ok] ${r.month} ${r.category_name}: ${fmtMoney(r.before_budgeted, iso)} ${arrow} ${fmtMoney(r.after_budgeted, iso)}${delta}, available ${fmtMoney(r.balance, iso)} — id ${r.category_id}`;
    }
    return `- [error] ${r.month} ${r.category}: ${r.error}`;
  });
  const rta = out.ready_to_assign.map(
    (m) =>
      `Ready to Assign ${m.month.slice(0, 7)}: ${fmtMoney(m.before, iso)} → ${m.after == null ? "(re-read failed)" : fmtMoney(m.after, iso)}${out.dry_run ? " (projected)" : ""}`,
  );
  return [header, ...lines, "", ...rta].join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Change a month's assigned (`budgeted`) amount on categories, in milliunits. Each move names a category by `category_id` or " +
  '`category_name` ("Groceries" or "Group: Name"; an ambiguous name is refused) and does one of: `set_budgeted_milliunits` (the new total), ' +
  "`add_milliunits` (signed change; negative takes money out), or `fund_goal: true` (add what the goal still needs this month). " +
  "`fund_underfunded` funds every underfunded goal in a month in the same call, minus `except` (names or ids; a name matching nothing refuses the call). " +
  "Moving money between categories is one negative and one positive add. `dry_run: true` returns the same before/after report and projected " +
  "Ready to Assign without writing. Moves run in order; a failed move doesn't stop the rest. The result has each category's before, after, " +
  "change, and available, and Ready to Assign before and after per month, so no re-read is needed. `add_milliunits` is not safe to retry blindly: " +
  "a repeat adds again. Requires write access; a read-only connection must be reconnected to use this tool.";

const moveSchema = z
  .object({
    month: monthParam.optional().default("current"),
    category_id: z.string().optional(),
    category_name: z.string().optional(),
    set_budgeted_milliunits: z.number().int().optional(),
    add_milliunits: z.number().int().optional(),
    fund_goal: z.literal(true).optional(),
  })
  .refine(
    (m) => (m.category_id === undefined) !== (m.category_name === undefined),
    {
      message: "Give exactly one of category_id or category_name.",
    },
  )
  .refine(
    (m) =>
      [m.set_budgeted_milliunits, m.add_milliunits, m.fund_goal].filter(
        (x) => x !== undefined,
      ).length === 1,
    {
      message:
        "Give exactly one of set_budgeted_milliunits, add_milliunits, or fund_goal.",
    },
  );

type MoveArg = z.infer<typeof moveSchema>;

export const toAssignMove = (m: MoveArg): AssignMoveInput => ({
  month: m.month,
  category: (m.category_id ?? m.category_name)!,
  op:
    m.set_budgeted_milliunits !== undefined
      ? { set: m.set_budgeted_milliunits }
      : m.add_milliunits !== undefined
        ? { add: m.add_milliunits }
        : { fundGoal: true },
});

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
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        moves: z.array(moveSchema).optional().default([]),
        fund_underfunded: z
          .object({
            month: monthParam.optional().default("current"),
            except: z.array(z.string()).optional().default([]),
          })
          .optional(),
        dry_run: z.boolean().optional().default(false),
      },
    },
    async ({ plan_id, moves, fund_underfunded, dry_run }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      if (!moves.length && !fund_underfunded) {
        return {
          ...text("Give `moves`, `fund_underfunded`, or both."),
          isError: true as const,
        };
      }
      try {
        const c = getClient();
        const [iso, out] = await Promise.all([
          c.planIso(plan_id),
          applyAssignToCategories(c, plan_id, {
            moves: moves.map(toAssignMove),
            fundUnderfunded: fund_underfunded,
            dryRun: dry_run,
          }),
        ]);
        if ("error" in out)
          return { ...text(out.error), isError: true as const };
        return result(renderAssignToCategoriesResult(out, iso), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
