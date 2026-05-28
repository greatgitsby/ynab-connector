import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Category,
  MonthDetail,
  Transaction,
  YnabClient,
} from "../ynab";
import {
  text,
  handleError,
  fmtMoney,
  pushSection,
  fmtCategoryLine,
  fmtTxLine,
} from "../format";
import { interpretGoal } from "../goals";
import { isSpendingCategory, isInboxableTx } from "../predicates";

// ---- Result type

export interface UnderfundedGoalRow {
  id: string;
  name: string;
  // milliunits still needed this month to stay on pace.
  underfunded: number;
  // The Category's goal_target in milliunits.
  goalTarget: number;
  // Cadence suffix from interpretGoal — "/month", "/week", " every 3 months", or "".
  cadenceLabel: string;
  // YYYY-MM-DD or null when the goal has no date.
  nextDueDate: string | null;
}

export interface TriageInbox {
  month: string;
  // Live Ready-to-Assign for the current month.
  readyToAssign: number;
  // Sorted desc by date.
  uncategorized: Transaction[];
  // Sorted desc by date. Excludes any tx that already appears in uncategorized.
  autoCategorized: Transaction[];
  // Sorted by balance asc (most overspent first).
  overspent: Category[];
  // Sorted by underfunded desc (largest gap first).
  underfunded: UnderfundedGoalRow[];
}

// ---- Compute (pure)

export const computeTriageInbox = (
  uncategorizedTxs: Transaction[],
  unapprovedTxs: Transaction[],
  monthDetail: MonthDetail,
): TriageInbox => {
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
): string => {
  const idSuffix = includeIds ? ` — id ${row.id}` : "";
  const date = row.nextDueDate ? ` by ${row.nextDueDate}` : "";
  return `- ${row.name}: needs ${fmtMoney(row.underfunded)} more this month (goal ${fmtMoney(row.goalTarget)}${row.cadenceLabel}${date})${idSuffix}`;
};

export const renderTriageInbox = (
  inbox: TriageInbox,
  opts: RenderOpts,
): string => {
  const out: string[] = [];
  out.push(`Triage inbox for month ${inbox.month}`);
  out.push(`Ready to assign: ${fmtMoney(inbox.readyToAssign)}`);
  out.push("");

  pushSection(
    out,
    "Uncategorized transactions",
    inbox.uncategorized,
    opts.maxPerSection,
    (t) => fmtTxLine(t, { showCategory: false, includeIds: opts.includeIds }),
  );
  pushSection(
    out,
    "Auto-categorized (verify category before approving)",
    inbox.autoCategorized,
    opts.maxPerSection,
    (t) => fmtTxLine(t, { includeIds: opts.includeIds }),
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
    (row) => fmtUnderfundedLine(row, opts.includeIds),
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
      description: DESCRIPTION,
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
    },
    async ({ budget_id, max_per_section, include_ids }) => {
      try {
        const c = getClient();
        const [uncatRes, unapprovedRes, monthRes] = await Promise.all([
          c.listTransactions(budget_id, { type: "uncategorized" }),
          c.listTransactions(budget_id, { type: "unapproved" }),
          c.getMonth(budget_id, "current"),
        ]);
        const inbox = computeTriageInbox(
          uncatRes.data.transactions,
          unapprovedRes.data.transactions,
          monthRes.data.month,
        );
        return text(
          renderTriageInbox(inbox, {
            maxPerSection: max_per_section,
            includeIds: include_ids,
          }),
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
