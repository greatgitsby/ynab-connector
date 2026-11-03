import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  Payee,
  SaveScheduledTransaction,
  ScheduledTransaction,
  Transaction,
  YnabClient,
} from "../ynab";
import { YnabError } from "../ynab";
import { fmtMoney, handleError, result, scopeDeniedError, text } from "../format";
import type { Props } from "../ynab-auth";

// ---- Result type

const ItemSchema = z.object({
  id: z.string(),
  // YYYY-MM-DD: the transaction date, or a scheduled transaction's next date.
  date: z.string(),
  amount: z.number().int(),
});

const LeftSchema = ItemSchema.extend({
  kind: z.enum(["split_part", "scheduled_split", "scheduled_split_part"]),
});

const FailedSchema = z.object({
  kind: z.enum(["transaction", "scheduled"]),
  id: z.string(),
  error: z.string(),
});

const SourceSchema = z.object({
  payee_id: z.string(),
  name: z.string(),
  // To move in a preview; moved once applied.
  transactions: z.array(ItemSchema),
  scheduled: z.array(ItemSchema),
  // Uses of the payee YNAB's API can't re-point. They stay on it.
  left: z.array(LeftSchema),
  // Writes YNAB rejected. Always empty in a preview.
  failed: z.array(FailedSchema),
});
export type MergeSource = z.infer<typeof SourceSchema>;

export const MergePayeesResultSchema = z.object({
  iso: z.string(),
  applied: z.boolean(),
  target: z.object({ id: z.string(), name: z.string() }),
  sources: z.array(SourceSchema),
});
export type MergePayeesResult = z.infer<typeof MergePayeesResultSchema>;

// ---- Compute (pure): what a merge would move

export const planMerge = (
  payees: Payee[],
  transactions: Transaction[],
  scheduled: ScheduledTransaction[],
  targetId: string,
  sourceIds: string[],
  iso: string,
): MergePayeesResult | { error: string } => {
  const live = new Map(payees.filter((p) => !p.deleted).map((p) => [p.id, p]));
  const target = live.get(targetId);
  if (!target) return { error: `No payee with id ${targetId} to merge into.` };
  if (target.transfer_account_id) {
    return { error: `"${target.name}" is a transfer payee; transfers can't be merged.` };
  }
  const ids = [...new Set(sourceIds)];
  if (ids.includes(targetId)) {
    return { error: `"${target.name}" is the target; leave it out of source_payee_ids.` };
  }
  const sources: MergeSource[] = [];
  for (const id of ids) {
    const p = live.get(id);
    if (!p) return { error: `No payee with id ${id}.` };
    if (p.transfer_account_id) {
      return { error: `"${p.name}" is a transfer payee; transfers can't be merged.` };
    }
    sources.push({ payee_id: id, name: p.name, transactions: [], scheduled: [], left: [], failed: [] });
  }
  const byId = new Map(sources.map((s) => [s.payee_id, s]));
  const at = (id: string | null | undefined) => (id ? byId.get(id) : undefined);

  for (const t of transactions) {
    if (t.deleted) continue;
    at(t.payee_id)?.transactions.push({ id: t.id, date: t.date, amount: t.amount });
    // YNAB rejects edits to the parts of an existing split.
    for (const s of t.subtransactions ?? []) {
      if (s.deleted) continue;
      at(s.payee_id)?.left.push({ kind: "split_part", id: t.id, date: t.date, amount: s.amount });
    }
  }
  for (const st of scheduled) {
    if (st.deleted) continue;
    const parts = st.subtransactions.filter((s) => !s.deleted);
    const item = { id: st.id, date: st.date_next, amount: st.amount };
    // Writing a scheduled transaction can't carry its split, so splits stay put.
    if (parts.length) at(st.payee_id)?.left.push({ kind: "scheduled_split", ...item });
    else at(st.payee_id)?.scheduled.push(item);
    for (const s of parts) {
      at(s.payee_id)?.left.push({ kind: "scheduled_split_part", ...item, amount: s.amount });
    }
  }
  return { iso, applied: false, target: { id: target.id, name: target.name }, sources };
};

// PUT replaces the whole scheduled transaction, so every field is carried over.
export const scheduledBody = (
  st: ScheduledTransaction,
  payeeId: string,
): SaveScheduledTransaction => ({
  account_id: st.account_id,
  date: st.date_next,
  amount: st.amount,
  payee_id: payeeId,
  category_id: st.category_id ?? null,
  memo: st.memo ?? null,
  flag_color: st.flag_color ?? null,
  frequency: st.frequency,
});

// ---- Effectful

const BULK_CHUNK = 100;

const errorMessage = (e: unknown) =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

export const applyMerge = async (
  client: YnabClient,
  planId: string,
  plan: MergePayeesResult,
  scheduled: ScheduledTransaction[],
): Promise<MergePayeesResult> => {
  const targetId = plan.target.id;
  const failed = new Map<string, string>();

  const txIds = plan.sources.flatMap((s) => s.transactions.map((t) => t.id));
  for (let i = 0; i < txIds.length; i += BULK_CHUNK) {
    const chunk = txIds.slice(i, i + BULK_CHUNK);
    try {
      const resp = await client.updateTransactionsBulk(planId, {
        transactions: chunk.map((id) => ({ id, payee_id: targetId })),
      });
      const updated = new Set(resp.data.transactions.map((t) => t.id));
      for (const id of chunk) {
        if (!updated.has(id)) failed.set(id, "Not in YNAB's bulk-update response.");
      }
    } catch (e) {
      for (const id of chunk) failed.set(id, errorMessage(e));
    }
  }

  const stById = new Map(scheduled.map((st) => [st.id, st]));
  for (const s of plan.sources) {
    for (const item of s.scheduled) {
      try {
        await client.updateScheduledTransaction(
          planId,
          item.id,
          scheduledBody(stById.get(item.id)!, targetId),
        );
      } catch (e) {
        failed.set(item.id, errorMessage(e));
      }
    }
  }

  return {
    ...plan,
    applied: true,
    sources: plan.sources.map((s) => ({
      ...s,
      transactions: s.transactions.filter((t) => !failed.has(t.id)),
      scheduled: s.scheduled.filter((t) => !failed.has(t.id)),
      failed: [
        ...s.transactions
          .filter((t) => failed.has(t.id))
          .map((t) => ({ kind: "transaction" as const, id: t.id, error: failed.get(t.id)! })),
        ...s.scheduled
          .filter((t) => failed.has(t.id))
          .map((t) => ({ kind: "scheduled" as const, id: t.id, error: failed.get(t.id)! })),
      ],
    })),
  };
};

// ---- Render (pure)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const LEFT_REASON: Record<z.infer<typeof LeftSchema>["kind"], string> = {
  split_part: "split part (YNAB's API can't edit an existing split's parts)",
  scheduled_split: "split scheduled transaction (YNAB's API can't write scheduled splits)",
  scheduled_split_part: "part of a split scheduled transaction (YNAB's API can't write scheduled splits)",
};

export const renderMerge = (r: MergePayeesResult): string => {
  const verb = r.applied ? "Moved" : "Would move";
  const out = [
    r.applied
      ? `## Merged ${plural(r.sources.length, "payee")} into "${r.target.name}"`
      : `## Preview: merge ${plural(r.sources.length, "payee")} into "${r.target.name}" (nothing changed yet)`,
  ];
  for (const s of r.sources) {
    const dates = s.transactions.map((t) => t.date).sort();
    const span = dates.length ? `, ${dates[0]} to ${dates[dates.length - 1]}` : "";
    const total = s.transactions.reduce((n, t) => n + t.amount, 0);
    const money = s.transactions.length ? `, total ${fmtMoney(total, r.iso)}` : "";
    out.push(
      `- "${s.name}" — id ${s.payee_id}: ${verb.toLowerCase()} ${plural(s.transactions.length, "transaction")}${span}${money}; ${plural(s.scheduled.length, "scheduled transaction")}`,
    );
    for (const f of s.failed) out.push(`  - [error] ${f.kind} ${f.id}: ${f.error}`);
    for (const l of s.left) {
      out.push(`  - stays: ${l.date} ${fmtMoney(l.amount, r.iso)} ${LEFT_REASON[l.kind]} — id ${l.id}`);
    }
  }
  const left = r.sources.reduce((n, s) => n + s.left.length + s.failed.length, 0);
  out.push("");
  if (!r.applied) {
    out.push("Call merge_payees again with apply: true to make these changes.");
  }
  if (left) {
    out.push(
      `${plural(left, "item")} will stay on the old payees; the user can re-point them by hand in YNAB.`,
    );
  }
  out.push(
    "The old payees still exist: YNAB's API can't delete payees, so future bank imports may " +
      "still land on them. To remove them, open Manage Payees in YNAB's web app (click the plan " +
      "name, top left): Delete All under unused payees removes every payee nothing uses, and " +
      "deleting one that is still used asks which payee its transactions move to.",
  );
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Consolidate duplicate payees: move every transaction and scheduled " +
  "transaction from the source payees to the target payee. By default it " +
  "only previews, listing what would move and what can't; show the preview " +
  "to the user, then call again with apply: true. YNAB's API can't re-point " +
  "parts of an existing split or split scheduled transactions; those are " +
  "reported and stay on the source. The source payees are not deleted (YNAB's API can't); the user deletes them in YNAB's web app, under Manage Payees. " +
  "Rename the target afterwards with rename_payees if needed. Find " +
  "candidates with review_payees. Transfer payees can't be merged. " +
  "Requires write access; a read-only connection must be reconnected to " +
  "use this tool.";

export const registerMergePayees = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "merge_payees",
    {
      title: "Merge Payees",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        target_payee_id: z.string().describe("The payee to keep."),
        source_payee_ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("The payees whose transactions move to the target."),
        apply: z
          .boolean()
          .optional()
          .default(false)
          .describe("false (default) previews without changing anything; true makes the changes."),
      },
    },
    async ({ plan_id, target_payee_id, source_payee_ids, apply }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const c = getClient();
        const [iso, payees, transactions, scheduled] = await Promise.all([
          c.planIso(plan_id),
          c.listPayees(plan_id),
          c.listTransactions(plan_id),
          c.listScheduledTransactions(plan_id),
        ]);
        const sts = scheduled.data.scheduled_transactions;
        const plan = planMerge(
          payees.data.payees,
          transactions.data.transactions,
          sts,
          target_payee_id,
          source_payee_ids,
          iso,
        );
        if ("error" in plan) return { ...text(plan.error), isError: true as const };
        const out = apply ? await applyMerge(c, plan_id, plan, sts) : plan;
        return result(renderMerge(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
