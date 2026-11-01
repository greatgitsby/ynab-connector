import { z } from "zod";
import { includeIdsParam, monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, MoneyMovement, YnabClient } from "../ynab";
import { MoneyMovementSchema } from "../wire";
import { result, handleError, fmtMoney, pushSection } from "../format";
import { resolveMonthRange } from "../month-window";
import { isSavingsCategory } from "../predicates";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const RTA = "Ready to Assign";

const MovementRowSchema = MoneyMovementSchema.extend({
  from_category_name: z.string(),
  to_category_name: z.string(),
  // Category to category, out of a savings-style goal (see isSavingsCategory).
  from_savings: z.boolean(),
});

const CategoryFlowSchema = z.object({
  category_id: z.string(),
  category_name: z.string(),
  // From Ready to Assign.
  assigned: z.number().int(),
  // Returned to Ready to Assign.
  unassigned: z.number().int(),
  // From and to other categories.
  moved_in: z.number().int(),
  moved_out: z.number().int(),
  // assigned - unassigned + moved_in - moved_out.
  net: z.number().int(),
});

export const MoneyMovementReportSchema = z.object({
  iso: z.string(),
  since_month: z.string(),
  until_month: z.string(),
  // Most recent first.
  money_movements: z.array(MovementRowSchema),
  // Largest absolute net first.
  by_category: z.array(CategoryFlowSchema),
});
export type MoneyMovementReport = z.infer<typeof MoneyMovementReportSchema>;

// ---- Compute (pure)

// A null category id is Ready to Assign: null `from` is an assignment, null
// `to` returns money to Ready to Assign.
export const computeMoneyMovements = (
  movements: MoneyMovement[],
  categories: Category[],
  opts: { since: string; until: string; iso: string },
): MoneyMovementReport => {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const name = (id: string | null | undefined) =>
    id == null ? RTA : (byId.get(id)?.name ?? `(unknown category ${id})`);

  const inRange = movements.filter(
    (m) =>
      !m.deleted && !!m.month && m.month >= opts.since && m.month <= opts.until,
  );
  const flows = new Map<string, z.infer<typeof CategoryFlowSchema>>();
  const flow = (id: string) => {
    let f = flows.get(id);
    if (!f) {
      f = {
        category_id: id,
        category_name: name(id),
        assigned: 0,
        unassigned: 0,
        moved_in: 0,
        moved_out: 0,
        net: 0,
      };
      flows.set(id, f);
    }
    return f;
  };
  for (const m of inRange) {
    const { from_category_id: from, to_category_id: to, amount } = m;
    if (to) {
      const f = flow(to);
      if (from) f.moved_in += amount;
      else f.assigned += amount;
      f.net += amount;
    }
    if (from) {
      const f = flow(from);
      if (to) f.moved_out += amount;
      else f.unassigned += amount;
      f.net -= amount;
    }
  }

  const rows = inRange
    .map((m) => {
      const from = m.from_category_id ? byId.get(m.from_category_id) : undefined;
      return {
        ...m,
        from_category_name: name(m.from_category_id),
        to_category_name: name(m.to_category_id),
        from_savings: !!from && !!m.to_category_id && isSavingsCategory(from),
      };
    })
    .sort((a, b) =>
      (b.moved_at ?? b.month ?? "").localeCompare(a.moved_at ?? a.month ?? ""),
    );

  return {
    iso: opts.iso,
    since_month: opts.since,
    until_month: opts.until,
    money_movements: rows,
    by_category: [...flows.values()].sort(
      (a, b) => Math.abs(b.net) - Math.abs(a.net),
    ),
  };
};

// ---- Render (pure)

export const renderMoneyMovements = (
  r: MoneyMovementReport,
  opts: { includeIds: boolean; maxRows: number },
): string => {
  const { iso } = r;
  const range =
    r.since_month === r.until_month
      ? r.since_month.slice(0, 7)
      : `${r.since_month.slice(0, 7)} to ${r.until_month.slice(0, 7)}`;
  const out = [`Money movements, ${range}`, ""];
  const fromSavings = r.money_movements.filter((m) => m.from_savings);
  pushSection(out, "Moved out of savings goals", fromSavings, opts.maxRows, (m) =>
    `- ${m.month?.slice(0, 7)} ${fmtMoney(m.amount, iso)} ${m.from_category_name} → ${m.to_category_name}`,
  );
  pushSection(out, "Net by category", r.by_category, opts.maxRows, (f) => {
    const parts = [
      f.assigned && `assigned ${fmtMoney(f.assigned, iso)}`,
      f.unassigned && `returned ${fmtMoney(f.unassigned, iso)}`,
      f.moved_in && `in ${fmtMoney(f.moved_in, iso)}`,
      f.moved_out && `out ${fmtMoney(f.moved_out, iso)}`,
    ].filter(Boolean);
    const idSuffix = opts.includeIds ? ` — id ${f.category_id}` : "";
    return `- ${f.category_name}: net ${fmtMoney(f.net, iso)} (${parts.join(", ")})${idSuffix}`;
  });
  pushSection(out, "Movements", r.money_movements, opts.maxRows, (m) => {
    const note = m.note ? ` "${m.note}"` : "";
    const idSuffix = opts.includeIds ? ` — id ${m.id}` : "";
    return `- ${m.moved_at?.slice(0, 10) ?? m.month} ${fmtMoney(m.amount, iso)} ${m.from_category_name} → ${m.to_category_name}${note}${idSuffix}`;
  });
  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Money movements: every assignment and every move of money between " +
  "categories in a month range (default the 3 months ending with the " +
  "current month). \"Ready to Assign\" as the source is an assignment; as " +
  "the destination, money returned. Reports each category's net flow and " +
  "flags category-to-category moves out of savings-style goals (target " +
  "balances and non-monthly Plan Your Spending targets), such as draining a " +
  "travel fund to cover dining out.";

export const registerListMoneyMovements = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_money_movements",
    {
      title: "List Money Movements",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        since_month: monthParam.optional(),
        until_month: monthParam.optional().default("current"),
        max_rows: z.number().int().min(1).max(500).optional().default(50),
        include_ids: includeIdsParam,
      },
      outputSchema: MoneyMovementReportSchema.shape,
    },
    async ({ plan_id, since_month, until_month, max_rows, include_ids }) => {
      try {
        const c = getClient();
        const range = resolveMonthRange(since_month, until_month, 3);
        const [mmRes, catsRes, iso] = await Promise.all([
          c.listMoneyMovements(plan_id),
          c.listCategories(plan_id),
          c.planIso(plan_id),
        ]);
        const categories = catsRes.data.category_groups.flatMap(
          (g) => g.categories ?? [],
        );
        const report = computeMoneyMovements(
          mmRes.data.money_movements,
          categories,
          { ...range, iso },
        );
        return result(
          renderMoneyMovements(report, {
            includeIds: include_ids,
            maxRows: max_rows,
          }),
          report,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
