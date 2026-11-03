import { z } from "zod";
import { includeIdsParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  Payee,
  ScheduledTransaction,
  Transaction,
  YnabClient,
} from "../ynab";
import { handleError, pushSection, result } from "../format";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const PayeeUsageSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Transactions and split parts that carry this payee.
  transaction_count: z.number().int(),
  scheduled_count: z.number().int(),
  // YYYY-MM-DD of the newest transaction, or null if never used.
  last_used: z.string().nullable(),
});
export type PayeeUsage = z.infer<typeof PayeeUsageSchema>;

export const PayeeReviewSchema = z.object({
  payee_count: z.number().int(),
  // Most-used payee first in each group; groups with the most use first.
  duplicate_groups: z.array(z.object({ payees: z.array(PayeeUsageSchema) })),
  // At most `max_uses` transactions and no scheduled transactions, least used first.
  little_used: z.array(PayeeUsageSchema),
});
export type PayeeReview = z.infer<typeof PayeeReviewSchema>;

// ---- Compute (pure)

// Card processors prefix the merchant ("SQ *Blue Bottle", "TST* Joe's").
const PROCESSOR_PREFIX = /^(sq|tst|pp|sp|py|paypal)\s*\*\s*/;

// Comparison key for spotting the same merchant under different names: case,
// accents, punctuation, spacing, store numbers (3+ digits), a processor
// prefix, and a leading "the" don't count.
export const payeeKey = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(PROCESSOR_PREFIX, "")
    .replace(/^the\s+/, "")
    .replace(/\d{3,}/g, "")
    .replace(/[^a-z0-9]/g, "");

// A key this short swallows unrelated names as a prefix ("star" → "starmarket").
const MIN_PREFIX_KEY = 5;

const byUse = (a: PayeeUsage, b: PayeeUsage) =>
  b.transaction_count - a.transaction_count ||
  b.scheduled_count - a.scheduled_count ||
  a.name.localeCompare(b.name);

export const computePayeeReview = (
  payees: Payee[],
  transactions: Transaction[],
  scheduled: ScheduledTransaction[],
  maxUses: number,
): PayeeReview => {
  // Transfer payees are named after accounts; they are never duplicates.
  const live = payees.filter((p) => !p.deleted && !p.transfer_account_id);
  const usage = new Map<string, PayeeUsage>(
    live.map((p) => [
      p.id,
      { id: p.id, name: p.name, transaction_count: 0, scheduled_count: 0, last_used: null },
    ]),
  );

  const countTx = (payeeId: string | null | undefined, date: string) => {
    const u = payeeId ? usage.get(payeeId) : undefined;
    if (!u) return;
    u.transaction_count++;
    if (!u.last_used || date > u.last_used) u.last_used = date;
  };
  for (const t of transactions) {
    if (t.deleted) continue;
    countTx(t.payee_id, t.date);
    for (const s of t.subtransactions ?? []) {
      if (!s.deleted && s.payee_id !== t.payee_id) countTx(s.payee_id, t.date);
    }
  }
  for (const st of scheduled) {
    if (st.deleted) continue;
    const ids = new Set([
      st.payee_id,
      ...st.subtransactions.filter((s) => !s.deleted).map((s) => s.payee_id),
    ]);
    for (const id of ids) {
      const u = id ? usage.get(id) : undefined;
      if (u) u.scheduled_count++;
    }
  }

  // Same key, or one key a prefix of another ("starbucks" / "starbuckswestshore").
  // Sorted keys put every extension of a key right after it.
  const keyed = [...usage.values()]
    .map((u) => ({ u, key: payeeKey(u.name) }))
    .filter((k) => k.key.length > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups: PayeeUsage[][] = [];
  let root = "";
  let current: PayeeUsage[] = [];
  for (const { u, key } of keyed) {
    const joins =
      current.length > 0 &&
      (key === root || (root.length >= MIN_PREFIX_KEY && key.startsWith(root)));
    if (joins) {
      current.push(u);
    } else {
      if (current.length > 1) groups.push(current);
      root = key;
      current = [u];
    }
  }
  if (current.length > 1) groups.push(current);

  const groupUse = (g: PayeeUsage[]) => g.reduce((n, u) => n + u.transaction_count, 0);
  const duplicate_groups = groups
    .map((g) => g.sort(byUse))
    .sort((a, b) => groupUse(b) - groupUse(a) || a[0].name.localeCompare(b[0].name))
    .map((payees) => ({ payees }));

  const little_used = [...usage.values()]
    .filter((u) => u.transaction_count <= maxUses && u.scheduled_count === 0)
    .sort((a, b) => a.transaction_count - b.transaction_count || a.name.localeCompare(b.name));

  return { payee_count: usage.size, duplicate_groups, little_used };
};

// ---- Render (pure)

const fmtUsage = (u: PayeeUsage, includeIds: boolean): string => {
  const n = `${u.transaction_count} transaction${u.transaction_count === 1 ? "" : "s"}`;
  const last = u.last_used ? `, last ${u.last_used}` : "";
  const sched = u.scheduled_count ? `, ${u.scheduled_count} scheduled` : "";
  const id = includeIds ? ` — id ${u.id}` : "";
  return `${u.name} (${n}${last}${sched})${id}`;
};

export const renderPayeeReview = (
  review: PayeeReview,
  maxUses: number,
  includeIds: boolean,
): string => {
  const out: string[] = [`# Payee review (${review.payee_count} payees)`, ""];
  pushSection(out, "Possible duplicates", review.duplicate_groups, 50, (g) =>
    `- ${g.payees.map((u) => fmtUsage(u, includeIds)).join("; ")}`,
  );
  pushSection(
    out,
    `Little used (≤${maxUses} transaction${maxUses === 1 ? "" : "s"}, nothing scheduled)`,
    review.little_used,
    100,
    (u) => `- ${fmtUsage(u, includeIds)}`,
  );
  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Review payees for cleanup: how often each is used, groups of likely " +
  "duplicates, and payees that are barely used. Duplicates are names that " +
  "match ignoring case, punctuation, store numbers, and card-processor " +
  "prefixes, or where one name extends another (\"Starbucks\" and " +
  "\"Starbucks Westshore\"). They are candidates: confirm with the user, and " +
  "look for duplicates the grouping can't see (\"AMZN Mktp\" and " +
  "\"Amazon\"). Each group lists its most-used payee first, usually the one " +
  "to keep. Consolidate with merge_payees and rename with rename_payees. " +
  "Transfer payees are left out. Reads every transaction in the plan, so " +
  "call it once per cleanup, not per payee.";

export const registerReviewPayees = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "review_payees",
    {
      title: "Review Payees",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        max_uses: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(1)
          .describe("A payee with at most this many transactions counts as little used."),
        include_ids: includeIdsParam,
      },
      outputSchema: PayeeReviewSchema.shape,
    },
    async ({ plan_id, max_uses, include_ids }) => {
      try {
        const c = getClient();
        const [payees, transactions, scheduled] = await Promise.all([
          c.listPayees(plan_id),
          c.listTransactions(plan_id),
          c.listScheduledTransactions(plan_id),
        ]);
        const review = computePayeeReview(
          payees.data.payees,
          transactions.data.transactions,
          scheduled.data.scheduled_transactions,
          max_uses,
        );
        return result(renderPayeeReview(review, max_uses, include_ids), review);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
