import { z } from "zod";
import { includeIdsParam, planIdParam } from "../schemas";
import { CategorySchema, TransactionSchema } from "../wire";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MonthDetail, Transaction, YnabClient } from "../ynab";
import {
  result,
  handleError,
  fmtMoney,
  pushSection,
  fmtCategoryLine,
  fmtTxLine,
} from "../format";
import { interpretGoal, isUnderfunded } from "../goals";
import {
  isSpendingCategory,
  isInboxableTx,
  isTrackingAccount,
} from "../predicates";

const UnderfundedGoalRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  underfunded: z.number(),
  goal_target: z.number(),
  cadence_label: z.string(),
  next_due_date: z.string().nullable(),
});
export type UnderfundedGoalRow = z.infer<typeof UnderfundedGoalRowSchema>;

export const TriageInboxSchema = z.object({
  iso: z.string(),
  month: z.string(),
  ready_to_assign: z.number(),
  uncategorized: z.array(TransactionSchema),
  auto_categorized: z.array(TransactionSchema),
  overspent: z.array(CategorySchema),
  underfunded: z.array(UnderfundedGoalRowSchema),
});
export type TriageInbox = z.infer<typeof TriageInboxSchema>;

export interface ComputeOpts {
  iso: string;
  trackingAccountIds?: ReadonlySet<string>;
}

export const computeTriageInbox = (
  uncategorizedTxs: Transaction[],
  unapprovedTxs: Transaction[],
  monthDetail: MonthDetail,
  opts: ComputeOpts,
): TriageInbox => {
  const { iso } = opts;
  const tracking = opts.trackingAccountIds ?? new Set<string>();
  const inboxable = (t: Transaction) =>
    isInboxableTx(t) && !tracking.has(t.account_id);
  const uncategorized = uncategorizedTxs
    .filter(inboxable)
    .sort((a, b) => b.date.localeCompare(a.date));
  const uncatIds = new Set(uncategorized.map((t) => t.id));
  const autoCategorized = unapprovedTxs
    .filter((t) => inboxable(t) && !uncatIds.has(t.id))
    .sort((a, b) => b.date.localeCompare(a.date));

  const monthCats = monthDetail.categories.filter(isSpendingCategory);
  const overspent = monthCats
    .filter((cat) => cat.balance < 0)
    .sort((a, b) => a.balance - b.balance);
  const underfunded: UnderfundedGoalRow[] = monthCats
    .flatMap((cat) => {
      const goal = interpretGoal(cat, monthDetail.month, iso);
      if (!isUnderfunded(goal)) return [];
      return [
        {
          id: cat.id,
          name: cat.name,
          underfunded: goal.underfundedThisMonth,
          goal_target: goal.targetAmount,
          cadence_label: goal.cadenceLabel,
          next_due_date: goal.nextDueDate,
        },
      ];
    })
    .sort((a, b) => b.underfunded - a.underfunded);

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

const DESCRIPTION =
  "What needs attention today, in one call: ready-to-assign, uncategorized transactions, auto-categorized transactions awaiting review, and this month's overspent categories and underfunded goals. The 'auto-categorized' categories are YNAB's guesses and often need correcting before approval. A transaction that is both uncategorized and unapproved appears only under 'uncategorized'. Tracking (off-budget) accounts such as brokerage or retirement accounts are left out: their transactions never take a category.";

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
        const [uncatRes, unapprovedRes, monthRes, accountsRes, iso] =
          await Promise.all([
            c.listTransactions(plan_id, { type: "uncategorized" }),
            c.listTransactions(plan_id, { type: "unapproved" }),
            c.getMonth(plan_id, "current"),
            c.listAccounts(plan_id),
            c.planIso(plan_id),
          ]);
        const trackingAccountIds = new Set(
          accountsRes.data.accounts.filter(isTrackingAccount).map((a) => a.id),
        );
        const inbox = computeTriageInbox(
          uncatRes.data.transactions,
          unapprovedRes.data.transactions,
          monthRes.data.month,
          { iso, trackingAccountIds },
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
