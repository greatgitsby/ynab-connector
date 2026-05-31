import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Category,
  CategoryGroup,
  MonthDetail,
  Transaction,
  YnabClient,
} from "../ynab";
import {
  text,
  result,
  handleError,
  fmtMoney,
  fmtActivityLine,
  type ActivityLineData,
} from "../format";
import { fmtGoalSuffix } from "../goals";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see ADR 0002).
// Money is in milliunits; goal cadence/percentage are non-money numbers.

// One expanded activity row (parent tx or split sub allocated to the
// category). Mirrors ActivityLineData from src/format.ts.
const ActivityLineDataSchema = z.object({
  date: z.string(),
  // Activity amount in milliunits.
  amount: z.number(),
  payee_name: z.string().nullable(),
  account_name: z.string(),
  approved: z.boolean(),
  parent_id: z.string(),
  sub_id: z.string().optional(),
  note: z.string().optional(),
});

// The YNAB Category shape (mirrors the Category interface in src/ynab.ts).
// Money fields (budgeted/activity/balance, goal_* amounts) are milliunits.
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

export const CategoryDetailsSchema = z.object({
  // Currency code (e.g. "USD") for formatting the milliunit amounts below.
  iso: z.string(),
  groupName: z.string(),
  category: CategorySchema,
  monthKey: z.string(),
  activity: z.array(ActivityLineDataSchema),
  // Sum of activity amounts (parents and matching subs both contribute).
  sum: z.number(),
});
export type CategoryDetails = z.infer<typeof CategoryDetailsSchema>;

// ---- Tool-local helper

// Expands transactions to one row per matching activity for the given
// category. Splits surface as one ActivityLineData per sub allocated to the
// category, labelled with a note pointing back to the parent payee.
const expandForCategory = (
  txs: Transaction[],
  categoryId: string,
): ActivityLineData[] => {
  const out: ActivityLineData[] = [];
  for (const t of txs) {
    if (t.subtransactions && t.subtransactions.length) {
      for (const s of t.subtransactions) {
        if (s.category_id !== categoryId) continue;
        out.push({
          date: t.date,
          amount: s.amount,
          payee_name: s.payee_name ?? t.payee_name,
          account_name: t.account_name,
          approved: t.approved,
          parent_id: t.id,
          sub_id: s.id,
          note: `split from "${t.payee_name ?? "(no payee)"}"`,
        });
      }
    } else if (t.category_id === categoryId) {
      out.push({
        date: t.date,
        amount: t.amount,
        payee_name: t.payee_name,
        account_name: t.account_name,
        approved: t.approved,
        parent_id: t.id,
      });
    }
  }
  return out;
};

// ---- Compute (pure)

export interface ComputeOpts {
  categoryId: string;
  // Currency code for the structured payload. Optional for callers (tests)
  // that don't care; the handler always passes the budget's real code.
  iso?: string;
}

// Returns null when the category is not present in the given month.
export const computeCategoryDetails = (
  monthDetail: MonthDetail,
  categoryGroups: CategoryGroup[],
  transactions: Transaction[],
  opts: ComputeOpts,
): CategoryDetails | null => {
  const category = monthDetail.categories.find((c) => c.id === opts.categoryId);
  if (!category) return null;

  let groupName = "(unknown group)";
  for (const g of categoryGroups) {
    if (g.categories.some((x) => x.id === opts.categoryId)) {
      groupName = g.name;
      break;
    }
  }

  const activity = expandForCategory(transactions, opts.categoryId).sort(
    (a, b) => b.date.localeCompare(a.date),
  );
  const sum = activity.reduce((acc, a) => acc + a.amount, 0);

  return {
    iso: opts.iso ?? "USD",
    groupName,
    category,
    monthKey: monthDetail.month,
    activity,
    sum,
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

export const renderCategoryDetails = (
  details: CategoryDetails,
  opts: RenderOpts,
): string => {
  const { iso, groupName, category, monthKey, activity, sum } = details;
  const out: string[] = [];
  out.push(`${groupName} → ${category.name}`);
  out.push(`Month: ${monthKey}`);
  out.push(
    `Budgeted: ${fmtMoney(category.budgeted, iso)}, activity ${fmtMoney(category.activity, iso)}, balance ${fmtMoney(category.balance, iso)}${fmtGoalSuffix(category, monthKey)}`,
  );
  out.push("");
  out.push(
    `Transactions this month (${activity.length}, sum ${fmtMoney(sum, iso)}):`,
  );
  if (!activity.length) out.push("(none)");
  for (const a of activity) {
    out.push(fmtActivityLine(a, opts.includeIds));
  }
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Drilldown for one category: its month aggregates (budgeted/activity/balance/goal) plus every transaction in that category for the given month (default 'current'). Split transactions are expanded: only the subtransactions allocated to this category appear, and each is labelled with its parent payee.";

export const registerGetCategoryDetails = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "get_category_details",
    {
      title: "Get Category Details",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        budget_id: z.string(),
        category_id: z.string(),
        month: z
          .string()
          .optional()
          .default("current")
          .describe("YYYY-MM-01 or 'current'"),
        include_ids: z.boolean().optional().default(false),
      },
      outputSchema: CategoryDetailsSchema.shape,
    },
    async ({ budget_id, category_id, month, include_ids }) => {
      try {
        const c = getClient();
        const monthRes = await c.getMonth(budget_id, month);
        const m = monthRes.data.month;
        if (!m.categories.some((x) => x.id === category_id)) {
          return text(`Category ${category_id} not found in month ${m.month}.`);
        }
        const [settingsRes, catsRes, txRes] = await Promise.all([
          c.getBudgetSettings(budget_id),
          c.listCategories(budget_id),
          c.listTransactions(budget_id, { sinceDate: m.month }),
        ]);
        const iso =
          settingsRes.data.settings.currency_format?.iso_code ?? "USD";
        const details = computeCategoryDetails(
          m,
          catsRes.data.category_groups,
          txRes.data.transactions,
          { categoryId: category_id, iso },
        );
        if (!details) {
          return text(`Category ${category_id} not found in month ${m.month}.`);
        }
        return result(
          renderCategoryDetails(details, { includeIds: include_ids }),
          details,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
