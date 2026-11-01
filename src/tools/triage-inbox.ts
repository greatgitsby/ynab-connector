import { z } from "zod";
import { includeIdsParam, planIdParam } from "../schemas";
import { CategorySchema, TransactionSchema } from "../wire";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  Category,
  MonthDetail,
  Transaction,
  YnabClient,
} from "../ynab";
import {
  result,
  handleError,
  fmtMoney,
  pushSection,
  fmtCategoryLine,
  fmtTxLine,
} from "../format";
import { interpretGoal } from "../goals";
import { isSpendingCategory, isInboxableTx } from "../predicates";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see docs/internals/structured-output.md).
// Money is in milliunits; `iso` is the currency code for formatting them.

const UnderfundedGoalRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  // milliunits still needed this month to stay on pace.
  underfunded: z.number(),
  // The Category's goal_target in milliunits.
  goal_target: z.number(),
  // Cadence suffix from interpretGoal — "/month", "/week", " every 3 months", or "".
  cadence_label: z.string(),
  // YYYY-MM-DD or null when the goal has no date.
  next_due_date: z.string().nullable(),
});
export type UnderfundedGoalRow = z.infer<typeof UnderfundedGoalRowSchema>;

export const TriageInboxSchema = z.object({
  // Currency code (e.g. "USD") for formatting the milliunit amounts below.
  iso: z.string(),
  month: z.string(),
  // Live Ready-to-Assign for the current month.
  ready_to_assign: z.number(),
  // Sorted desc by date.
  uncategorized: z.array(TransactionSchema),
  // Sorted desc by date. Excludes any tx that already appears in uncategorized.
  auto_categorized: z.array(TransactionSchema),
  // Sorted by balance asc (most overspent first).
  overspent: z.array(CategorySchema),
  // Sorted by underfunded desc (largest gap first).
  underfunded: z.array(UnderfundedGoalRowSchema),
});
export type TriageInbox = z.infer<typeof TriageInboxSchema>;

// ---- Compute (pure)

export interface ComputeOpts {
  // Currency code for the structured payload. Optional for callers (tests)
  // that don't care; the handler always passes the plan's real code.
  iso?: string;
}

export const computeTriageInbox = (
  uncategorizedTxs: Transaction[],
  unapprovedTxs: Transaction[],
  monthDetail: MonthDetail,
  opts: ComputeOpts = {},
): TriageInbox => {
  const iso = opts.iso ?? "USD";
  const uncategorized = uncategorizedTxs
    .filter(isInboxableTx)
    .sort((a, b) => b.date.localeCompare(a.date));
  const uncatIds = new Set(uncategorized.map((t) => t.id));
  const autoCategorized = unapprovedTxs
    .filter((t) => isInboxableTx(t) && !uncatIds.has(t.id))
    .sort((a, b) => b.date.localeCompare(a.date));

  const monthCats = monthDetail.categories.filter(isSpendingCategory);
  const overspent = monthCats
    .filter((cat) => cat.balance < 0)
    .sort((a, b) => a.balance - b.balance);
  const underfundedCats = monthCats
    .filter((cat) => (cat.goal_under_funded ?? 0) > 0)
    .sort(
      (a, b) => (b.goal_under_funded ?? 0) - (a.goal_under_funded ?? 0),
    );

  const underfunded: UnderfundedGoalRow[] = underfundedCats.map((cat) => {
    const goal = interpretGoal(cat, monthDetail.month, iso);
    return {
      id: cat.id,
      name: cat.name,
      underfunded: cat.goal_under_funded ?? 0,
      goal_target: cat.goal_target ?? 0,
      cadence_label: goal?.cadenceLabel ?? "",
      next_due_date: goal?.nextDueDate ?? null,
    };
  });

  return {
    iso,
    month: monthDetail.month,
    ready_to_assign: monthDetail.to_be_budgeted,
    uncategorized,
    auto_categorized: autoCategorized,
    overspent,
    underfunded,
  };
};

// ---- Render (pure)

export interface RenderOpts {
  maxPerSection: number;
  includeIds: boolean;
}

const fmtUnderfundedLine = (
  row: UnderfundedGoalRow,
  includeIds: boolean,
  iso: string,
): string => {
  const idSuffix = includeIds ? ` — id ${row.id}` : "";
  const date = row.next_due_date ? ` by ${row.next_due_date}` : "";
  return `- ${row.name}: needs ${fmtMoney(row.underfunded, iso)} more this month (goal ${fmtMoney(row.goal_target, iso)}${row.cadence_label}${date})${idSuffix}`;
};

export const renderTriageInbox = (
  inbox: TriageInbox,
  opts: RenderOpts,
): string => {
  const iso = inbox.iso;
  const out: string[] = [];
  out.push(`Triage inbox for month ${inbox.month}`);
  out.push(`Ready to Assign: ${fmtMoney(inbox.ready_to_assign, iso)}`);
  out.push("");

  pushSection(
    out,
    "Uncategorized transactions",
    inbox.uncategorized,
    opts.maxPerSection,
    (t) =>
      fmtTxLine(t, iso, { showCategory: false, includeIds: opts.includeIds }),
  );
  pushSection(
    out,
    "Auto-categorized (verify category before approving)",
    inbox.auto_categorized,
    opts.maxPerSection,
    (t) => fmtTxLine(t, iso, { includeIds: opts.includeIds }),
  );
  pushSection(
    out,
    "Overspent categories (current month)",
    inbox.overspent,
    opts.maxPerSection,
    (cat) => fmtCategoryLine(cat, inbox.month, iso, opts.includeIds),
  );
  pushSection(
    out,
    "Underfunded goals (current month)",
    inbox.underfunded,
    opts.maxPerSection,
    (row) => fmtUnderfundedLine(row, opts.includeIds, iso),
  );

  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "What needs attention today, in one call: ready-to-assign, uncategorized transactions, auto-categorized transactions awaiting review, and this month's overspent categories and underfunded goals. The 'auto-categorized' categories are YNAB's guesses and often need correcting before approval. A transaction that is both uncategorized and unapproved appears only under 'uncategorized'.";

export const registerTriageInbox = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "triage_inbox",
    {
      title: "Triage Inbox",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        max_per_section: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .default(25),
        include_ids: includeIdsParam,
      },
      outputSchema: TriageInboxSchema.shape,
    },
    async ({ plan_id, max_per_section, include_ids }) => {
      try {
        const c = getClient();
        const [uncatRes, unapprovedRes, monthRes, iso] = await Promise.all([
          c.listTransactions(plan_id, { type: "uncategorized" }),
          c.listTransactions(plan_id, { type: "unapproved" }),
          c.getMonth(plan_id, "current"),
          c.planIso(plan_id),
        ]);
        const inbox = computeTriageInbox(
          uncatRes.data.transactions,
          unapprovedRes.data.transactions,
          monthRes.data.month,
          { iso },
        );
        return result(
          renderTriageInbox(inbox, {
            maxPerSection: max_per_section,
            includeIds: include_ids,
          }),
          inbox,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
