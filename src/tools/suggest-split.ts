import { z } from "zod";
import { monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, MonthDetail, Transaction, YnabClient } from "../ynab";
import { fmtMoney, handleError, result, text } from "../format";
import { RowSchema, addDays, flattenTransactions, pickRow, todayIso, type FlatRow } from "../rows";
import { isSpendingCategory, isSplitTx } from "../predicates";
import { categoryRefs, resolveAll } from "../resolve";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const PartSchema = z.object({
  category_id: z.string(),
  category_name: z.string(),
  // Signed like the charge: negative for an outflow.
  amount: z.number().int(),
  // history: this payee has charged this amount to this category before.
  // goal: the category's goal target.
  source: z.enum(["history", "goal"]),
});

const SuggestionSchema = z.object({
  parts: z.array(PartSchema),
  // Higher is likelier: repeat history matches, goal-target matches, and
  // categories not yet charged this month count for it; extra parts against.
  score: z.number(),
  // Ready to pass to update_transactions as `subtransactions`.
  subtransactions: z.array(
    z.object({ amount_milliunits: z.number().int(), category_id: z.string() }),
  ),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const SplitSuggestionsSchema = z.object({
  iso: z.string(),
  amount: z.number().int(),
  transaction: RowSchema.nullable(),
  // YNAB can't re-split an existing split; suggestions are then for review only.
  already_split: z.boolean(),
  candidate_count: z.number().int(),
  // False when the search stopped at its step budget; more combinations may exist.
  exhaustive: z.boolean(),
  suggestions: z.array(SuggestionSchema),
});
export type SplitSuggestions = z.infer<typeof SplitSuggestionsSchema>;

// ---- Compute (pure)

export interface Candidate {
  category_id: string;
  category_name: string;
  amount: number; // positive magnitude
  source: "history" | "goal";
  // Times this payee charged this amount to this category.
  times: number;
  // The amount is the category's goal target.
  goal_match: boolean;
  // No activity in the category yet this month.
  uncharged: boolean;
}

// Amounts this payee charged to each category before (whole charges and
// split parts), then every spending category's goal target. One candidate per
// (category, amount).
export const buildCandidates = (
  history: FlatRow[],
  month: MonthDetail,
  opts: { allowed?: ReadonlySet<string>; sign: number },
): Candidate[] => {
  const cats = new Map(month.categories.filter(isSpendingCategory).map((c) => [c.id, c]));
  const byKey = new Map<string, Candidate>();
  const add = (c: Category, amount: number, source: Candidate["source"]) => {
    if (amount <= 0 || (opts.allowed && !opts.allowed.has(c.id))) return;
    const key = `${c.id}|${amount}`;
    const prev = byKey.get(key);
    if (prev) {
      if (source === "history") prev.times += 1;
      return;
    }
    byKey.set(key, {
      category_id: c.id,
      category_name: c.name,
      amount,
      source,
      times: source === "history" ? 1 : 0,
      goal_match: c.goal_target === amount,
      uncharged: c.activity === 0,
    });
  };
  for (const r of history) {
    const c = r.category_id ? cats.get(r.category_id) : undefined;
    if (c && Math.sign(r.amount) === opts.sign) add(c, Math.abs(r.amount), "history");
  }
  for (const c of cats.values()) {
    if (c.goal_type && c.goal_target) add(c, c.goal_target, "goal");
  }
  return [...byKey.values()];
};

// Combinations of candidates, each category at most once, summing exactly to
// `target`. A depth-first search over amounts, largest first, pruned by what
// is left to add; it stops after `budget` steps.
export const findSplits = (
  candidates: Candidate[],
  target: number,
  opts: { maxParts: number; maxResults: number; budget?: number },
): { combos: Candidate[][]; exhaustive: boolean } => {
  const items = [...candidates].sort((a, b) => b.amount - a.amount);
  const suffix = items.map((_, i) => items.slice(i).reduce((a, c) => a + c.amount, 0));
  const combos: Candidate[][] = [];
  const keys = new Set<string>();
  let steps = 0;
  const budget = opts.budget ?? 200_000;
  const pick: Candidate[] = [];
  const used = new Set<string>();
  const walk = (i: number, left: number): boolean => {
    if (++steps > budget) return false;
    if (left === 0) {
      const key = pick.map((p) => `${p.category_id}|${p.amount}`).sort().join(",");
      if (!keys.has(key)) {
        keys.add(key);
        combos.push([...pick]);
      }
      return combos.length < opts.maxResults * 20;
    }
    if (i >= items.length || pick.length >= opts.maxParts || suffix[i] < left) return true;
    const c = items[i];
    if (c.amount <= left && !used.has(c.category_id)) {
      pick.push(c);
      used.add(c.category_id);
      const go = walk(i + 1, left - c.amount);
      pick.pop();
      used.delete(c.category_id);
      if (!go) return false;
    }
    return walk(i + 1, left);
  };
  const exhaustive = walk(0, target) && steps <= budget;
  return { combos, exhaustive };
};

const score = (parts: Candidate[]): number =>
  parts.reduce(
    (s, p) =>
      s +
      (p.times ? 2 + Math.min(p.times, 5) * 0.2 : 0) +
      (p.goal_match ? 1 : 0) +
      (p.uncharged ? 1 : 0),
    0,
  ) - parts.length;

export const computeSplitSuggestions = (
  input: { amount: number; tx: FlatRow | null; alreadySplit: boolean; candidates: Candidate[] },
  opts: { iso: string; maxParts: number; maxSuggestions: number },
): SplitSuggestions => {
  const sign = input.amount < 0 ? -1 : 1;
  const { combos, exhaustive } = findSplits(input.candidates, Math.abs(input.amount), {
    maxParts: opts.maxParts,
    maxResults: opts.maxSuggestions,
  });
  const suggestions = combos
    .map((parts) => ({ parts, score: score(parts) }))
    .sort((a, b) => b.score - a.score || a.parts.length - b.parts.length)
    .slice(0, opts.maxSuggestions)
    .map(({ parts, score }) => ({
      score,
      parts: parts.map((p) => ({
        category_id: p.category_id,
        category_name: p.category_name,
        amount: sign * p.amount,
        source: p.source,
      })),
      subtransactions: parts.map((p) => ({ amount_milliunits: sign * p.amount, category_id: p.category_id })),
    }));
  return {
    iso: opts.iso,
    amount: input.amount,
    transaction: input.tx ? pickRow(input.tx) : null,
    already_split: input.alreadySplit,
    candidate_count: input.candidates.length,
    exhaustive,
    suggestions,
  };
};

// ---- Render (pure)

export const renderSplitSuggestions = (s: SplitSuggestions): string => {
  const { iso } = s;
  const tx = s.transaction;
  const out = [
    tx
      ? `Split suggestions for ${tx.date} ${fmtMoney(s.amount, iso)} ${tx.payee ?? ""} (id ${tx.id})`
      : `Split suggestions for ${fmtMoney(s.amount, iso)}`,
  ];
  if (s.already_split) {
    out.push("Already a split: YNAB's API can't change its parts. The user edits it in YNAB.");
  }
  if (!s.suggestions.length) {
    out.push(`No combination of ${s.candidate_count} candidate amounts sums to ${fmtMoney(s.amount, iso)}.`);
    return out.join("\n");
  }
  s.suggestions.forEach((g, i) => {
    out.push(
      "",
      `${i + 1}. ${g.parts.map((p) => `${p.category_name} ${fmtMoney(p.amount, iso)} (${p.source})`).join(" + ")}`,
    );
  });
  if (!s.exhaustive) out.push("", "Search stopped early; narrow with `categories` for more.");
  out.push(
    "",
    "Nothing was written. To apply one, pass its `subtransactions` to update_transactions with this transaction id.",
  );
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Suggest how to split one aggregate charge (Virtual Card, Apple, Amazon) across categories: combinations of known amounts that sum exactly " +
  "to it. Candidates are amounts this payee charged to each category before (whole charges and split parts) and every category's goal target, " +
  "optionally limited to `categories` (names or ids). Ranked by history matches and categories not yet charged this month. " +
  "Read-only, so it is the dry run: apply a suggestion by passing its `subtransactions` to update_transactions. " +
  "Give `transaction_id`, or `amount_milliunits` with optional `payee` to test an amount.";

export const registerSuggestSplit = (server: McpServer, getClient: () => YnabClient) => {
  server.registerTool(
    "suggest_split",
    {
      title: "Suggest Split",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        transaction_id: z.string().optional(),
        amount_milliunits: z.number().int().optional().describe("Signed; outflows negative."),
        payee: z.string().optional().describe("Payee name or id whose history to use with amount_milliunits."),
        categories: z.array(z.string()).optional(),
        month: monthParam.optional().default("current").describe("Month whose goals and activity to use."),
        history_days: z.number().int().min(0).max(730).optional().default(180),
        max_parts: z.number().int().min(1).max(10).optional().default(5),
        max_suggestions: z.number().int().min(1).max(20).optional().default(5),
      },
      outputSchema: SplitSuggestionsSchema.shape,
    },
    async (args) => {
      if ((args.transaction_id === undefined) === (args.amount_milliunits === undefined)) {
        return { ...text("Give transaction_id or amount_milliunits."), isError: true as const };
      }
      try {
        const c = getClient();
        const since = addDays(todayIso(), -args.history_days);
        const [txRes, monthRes, historyRes, catsRes, iso] = await Promise.all([
          args.transaction_id ? c.getTransaction(args.plan_id, args.transaction_id) : null,
          c.getMonth(args.plan_id, args.month),
          c.listTransactions(args.plan_id, { sinceDate: since }),
          args.categories ? c.listCategories(args.plan_id) : null,
          c.planIso(args.plan_id),
        ]);
        const tx: Transaction | null = txRes?.data.transaction ?? null;
        const amount = tx ? tx.amount : args.amount_milliunits!;
        if (amount === 0) return { ...text("The amount is zero; nothing to split."), isError: true as const };

        let allowed: Set<string> | undefined;
        if (args.categories && catsRes) {
          allowed = new Set();
          const refs = categoryRefs(catsRes.data.category_groups);
          for (const ref of args.categories) {
            const r = resolveAll(refs, ref, "category");
            if (!r.ok) return { ...text(r.error), isError: true as const };
            for (const m of r.matches) allowed.add(m.id);
          }
        }
        const rows = flattenTransactions(historyRes.data.transactions);
        const payeeRef = tx?.payee_id ?? args.payee;
        const history = payeeRef
          ? rows.filter(
              (r) =>
                r.id !== tx?.id &&
                (r.payee_id === payeeRef || (r.payee ?? "").toLowerCase() === payeeRef.toLowerCase()),
            )
          : [];
        const candidates = buildCandidates(history, monthRes.data.month, {
          allowed,
          sign: amount < 0 ? -1 : 1,
        });
        const txRow = tx ? (flattenTransactions([{ ...tx, subtransactions: [] }])[0] ?? null) : null;
        const s = computeSplitSuggestions(
          { amount, tx: txRow, alreadySplit: tx ? isSplitTx(tx) : false, candidates },
          { iso, maxParts: args.max_parts, maxSuggestions: args.max_suggestions },
        );
        return result(renderSplitSuggestions(s), s);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
