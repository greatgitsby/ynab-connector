import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
// inferred and the schema doubles as the tool's outputSchema — see ADR 0002).
// Money is in milliunits; `iso` is the currency code for formatting them.

// Mirrors the YNAB SubTransaction shape (see ynab.ts).
const SubTransactionSchema = z.object({
  id: z.string(),
  transaction_id: z.string(),
  amount: z.number(),
  memo: z.string().nullable(),
  payee_id: z.string().nullable(),
  payee_name: z.string().nullable(),
  category_id: z.string().nullable(),
  category_name: z.string().nullable(),
});

// Mirrors the YNAB Transaction shape (see ynab.ts). `amount` is milliunits.
const TransactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  memo: z.string().nullable(),
  cleared: z.string(),
  approved: z.boolean(),
  account_id: z.string(),
  account_name: z.string(),
  payee_id: z.string().nullable(),
  payee_name: z.string().nullable(),
  category_id: z.string().nullable(),
  category_name: z.string().nullable(),
  flag_color: z.string().nullable(),
  transfer_account_id: z.string().nullable(),
  deleted: z.boolean().optional(),
  subtransactions: z.array(SubTransactionSchema).optional(),
});

// Mirrors the YNAB Category shape (see ynab.ts). Money fields are milliunits.
const CategorySchema = z.object({
  id: z.string(),
  category_group_id: z.string(),
  category_group_name: z.string().optional(),
  name: z.string(),
  hidden: z.boolean(),
  internal: z.boolean().optional(),
  deleted: z.boolean().optional(),
  budgeted: z.number(),
  activity: z.number(),
  balance: z.number(),
  goal_type: z.string().nullable().optional(),
  goal_target: z.number().nullable().optional(),
  goal_target_date: z.string().nullable().optional(),
  goal_cadence: z.number().nullable().optional(),
  goal_cadence_frequency: z.number().nullable().optional(),
  goal_months_to_budget: z.number().nullable().optional(),
  goal_percentage_complete: z.number().nullable().optional(),
  goal_under_funded: z.number().nullable().optional(),
  goal_overall_funded: z.number().nullable().optional(),
  goal_overall_left: z.number().nullable().optional(),
});

const UnderfundedGoalRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  // milliunits still needed this month to stay on pace.
  underfunded: z.number(),
  // The Category's goal_target in milliunits.
  goalTarget: z.number(),
  // Cadence suffix from interpretGoal — "/month", "/week", " every 3 months", or "".
  cadenceLabel: z.string(),
  // YYYY-MM-DD or null when the goal has no date.
  nextDueDate: z.string().nullable(),
});
export type UnderfundedGoalRow = z.infer<typeof UnderfundedGoalRowSchema>;

export const TriageInboxSchema = z.object({
  // Currency code (e.g. "USD") for formatting the milliunit amounts below.
  iso: z.string(),
  month: z.string(),
  // Live Ready-to-Assign for the current month.
  readyToAssign: z.number(),
  // Sorted desc by date.
  uncategorized: z.array(TransactionSchema),
  // Sorted desc by date. Excludes any tx that already appears in uncategorized.
  autoCategorized: z.array(TransactionSchema),
  // Sorted by balance asc (most overspent first).
  overspent: z.array(CategorySchema),
  // Sorted by underfunded desc (largest gap first).
  underfunded: z.array(UnderfundedGoalRowSchema),
});
export type TriageInbox = z.infer<typeof TriageInboxSchema>;

// ---- Compute (pure)

export interface ComputeOpts {
  // Currency code for the structured payload. Optional for callers (tests)
  // that don't care; the handler always passes the budget's real code.
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
    const goal = interpretGoal(cat, monthDetail.month);
    return {
      id: cat.id,
      name: cat.name,
      underfunded: cat.goal_under_funded ?? 0,
      goalTarget: cat.goal_target ?? 0,
      cadenceLabel: goal?.cadenceLabel ?? "",
      nextDueDate: goal?.nextDueDate ?? null,
    };
  });

  return {
    iso,
    month: monthDetail.month,
    readyToAssign: monthDetail.to_be_budgeted,
    uncategorized,
    autoCategorized,
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
  const date = row.nextDueDate ? ` by ${row.nextDueDate}` : "";
  return `- ${row.name}: needs ${fmtMoney(row.underfunded, iso)} more this month (goal ${fmtMoney(row.goalTarget, iso)}${row.cadenceLabel}${date})${idSuffix}`;
};

export const renderTriageInbox = (
  inbox: TriageInbox,
  opts: RenderOpts,
): string => {
  const iso = inbox.iso;
  const out: string[] = [];
  out.push(`Triage inbox for month ${inbox.month}`);
  out.push(`Ready to assign: ${fmtMoney(inbox.readyToAssign, iso)}`);
  out.push("");

  pushSection(
    out,
    "Uncategorized transactions",
    inbox.uncategorized,
    opts.maxPerSection,
    (t) =>
      fmtTxLine(t, { showCategory: false, includeIds: opts.includeIds, iso }),
  );
  pushSection(
    out,
    "Auto-categorized (verify category before approving)",
    inbox.autoCategorized,
    opts.maxPerSection,
    (t) => fmtTxLine(t, { includeIds: opts.includeIds, iso }),
  );
  pushSection(
    out,
    "Overspent categories (current month)",
    inbox.overspent,
    opts.maxPerSection,
    (cat) => fmtCategoryLine(cat, inbox.month, opts.includeIds),
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
  "Day-to-day triage view: ready-to-assign, uncategorized transactions, auto-categorized transactions awaiting review, overspent categories (current month), and underfunded goals (current month) — all in one call. The 'auto-categorized' section is YNAB's guess at a category; it often needs correction before being approved. A transaction appearing in both 'uncategorized' and 'unapproved' is shown only under 'uncategorized'.";

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
        budget_id: z.string(),
        max_per_section: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .default(25),
        include_ids: z.boolean().optional().default(false),
      },
      outputSchema: TriageInboxSchema.shape,
    },
    async ({ budget_id, max_per_section, include_ids }) => {
      try {
        const c = getClient();
        const [uncatRes, unapprovedRes, monthRes, settingsRes] =
          await Promise.all([
            c.listTransactions(budget_id, { type: "uncategorized" }),
            c.listTransactions(budget_id, { type: "unapproved" }),
            c.getMonth(budget_id, "current"),
            c.getBudgetSettings(budget_id),
          ]);
        const iso =
          settingsRes.data.settings.currency_format?.iso_code ?? "USD";
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
