import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FLAG_COLORS,
  type CategoryGroup,
  type MonthDetail,
  type SaveSubTransaction,
  type SaveTransactionWithId,
  type Transaction,
  type YnabClient,
} from "../ynab";
import { TransactionSchema } from "../wire";
import {
  fmtMoney,
  fmtSplitLines,
  handleError,
  result,
  scopeDeniedError,
  errorMessage,
} from "../format";
import type { Props } from "../ynab-auth";
import { isSplitTx } from "../predicates";
import { categoryRefs, resolveOne } from "../resolve";

const subSchema = z.object({
  amount_milliunits: z.number().int(),
  category_id: z.string().nullable().optional(),
  category_name: z.string().optional(),
  memo: z.string().nullable().optional(),
  payee_name: z.string().optional(),
  payee_id: z.string().optional(),
});

type UpdateSubInput = z.infer<typeof subSchema>;

const updateSchema = z
  .object({
    transaction_id: z.string(),
    category_id: z.string().nullable().optional(),
    category_name: z.string().optional(),
    payee_name: z.string().optional(),
    payee_id: z.string().optional(),
    memo: z.string().nullable().optional(),
    approved: z.boolean().optional(),
    cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional(),
    flag_color: z.enum(FLAG_COLORS).nullable().optional(),
    subtransactions: z.array(subSchema).optional(),
  })
  .refine(
    (v) => !(v.category_id !== undefined && v.category_name !== undefined),
    {
      message: "Give category_id or category_name, not both.",
      path: ["category_name"],
    },
  )
  .refine(
    (v) =>
      !(
        v.subtransactions &&
        (v.category_id != null || v.category_name !== undefined)
      ),
    {
      message:
        "When `subtransactions` is set, the parent's `category_id` must be null or omitted.",
      path: ["category_id"],
    },
  );

export type UpdateTransactionInput = z.infer<typeof updateSchema>;

const UpdateTransactionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    transaction_id: z.string(),
    transaction: TransactionSchema,
  }),
  z.object({
    ok: z.literal(false),
    transaction_id: z.string(),
    error: z.string(),
  }),
]);
export type UpdateTransactionResult = z.infer<
  typeof UpdateTransactionResultSchema
>;

const CategoryBalanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  budgeted: z.number(),
  activity: z.number(),
  balance: z.number(),
});
type CategoryBalance = z.infer<typeof CategoryBalanceSchema>;

const UpdateTransactionsResultSchema = z.object({
  results: z.array(UpdateTransactionResultSchema),
  after: z
    .object({
      month: z.string(),
      ready_to_assign: z.number(),
      category_balances: z.array(CategoryBalanceSchema),
    })
    .nullable(),
});
export type UpdateTransactionsResult = z.infer<
  typeof UpdateTransactionsResultSchema
>;

export const resolveCategoryNames = (
  inputs: UpdateTransactionInput[],
  groups: CategoryGroup[],
): {
  inputs: UpdateTransactionInput[];
  failed: Map<UpdateTransactionInput, string>;
} => {
  const refs = categoryRefs(groups);
  const failed = new Map<UpdateTransactionInput, string>();
  const resolved = inputs.map((input) => {
    const errors: string[] = [];
    const lookup = (
      name: string | undefined,
      id: string | null | undefined,
    ) => {
      if (name === undefined) return id;
      const r = resolveOne(refs, name, "category");
      if (r.ok) return r.matches[0].id;
      errors.push(r.error);
      return id;
    };
    const { category_name, ...rest } = input;
    const out: UpdateTransactionInput = { ...rest };
    const catId = lookup(category_name, input.category_id);
    if (catId !== undefined) out.category_id = catId;
    if (input.subtransactions) {
      out.subtransactions = input.subtransactions.map(
        ({ category_name: n, ...sub }) => {
          const id = lookup(n, sub.category_id);
          return id !== undefined ? { ...sub, category_id: id } : sub;
        },
      );
    }
    if (errors.length) failed.set(out, errors.join(" "));
    return out;
  });
  return { inputs: resolved, failed };
};

export const touchedBalances = (
  results: UpdateTransactionResult[],
  month: MonthDetail,
): CategoryBalance[] => {
  const ids = new Set<string>();
  for (const r of results) {
    if (!r.ok) continue;
    if (r.transaction.category_id) ids.add(r.transaction.category_id);
    for (const s of r.transaction.subtransactions ?? []) {
      if (!s.deleted && s.category_id) ids.add(s.category_id);
    }
  }
  return month.categories
    .filter((c) => ids.has(c.id) && !c.internal)
    .map((c) => ({
      id: c.id,
      name: c.name,
      budgeted: c.budgeted,
      activity: c.activity,
      balance: c.balance,
    }));
};

export const buildBulkRow = (
  input: UpdateTransactionInput,
): SaveTransactionWithId => {
  const row: SaveTransactionWithId = { id: input.transaction_id };
  if (input.category_id !== undefined) row.category_id = input.category_id;
  if (input.payee_id !== undefined) row.payee_id = input.payee_id;
  if (input.payee_name !== undefined) row.payee_name = input.payee_name;
  if (input.memo !== undefined) row.memo = input.memo;
  if (input.approved !== undefined) row.approved = input.approved;
  if (input.cleared !== undefined) row.cleared = input.cleared;
  if (input.flag_color !== undefined) row.flag_color = input.flag_color;
  if (input.subtransactions !== undefined) {
    row.subtransactions = input.subtransactions.map(toWireSub);
  }
  return row;
};

const toWireSub = (s: UpdateSubInput): SaveSubTransaction => {
  const out: SaveSubTransaction = { amount: s.amount_milliunits };
  if (s.category_id !== undefined) out.category_id = s.category_id;
  if (s.payee_id !== undefined) out.payee_id = s.payee_id;
  if (s.payee_name !== undefined) out.payee_name = s.payee_name;
  if (s.memo !== undefined) out.memo = s.memo;
  return out;
};

// YNAB's bulk PATCH response includes the updated transactions in arbitrary
// order. Failed rows are left out of the response, so an input missing from it gets
// a generic error. `failed` carries inputs that already have an error (refused
// before sending, or a whole-batch failure).
export const interpretBulkResponse = (
  inputs: UpdateTransactionInput[],
  updatedTransactions: Transaction[],
  failed: ReadonlyMap<UpdateTransactionInput, string> = new Map(),
): UpdateTransactionsResult => {
  const byId = new Map(updatedTransactions.map((t) => [t.id, t]));
  return {
    results: inputs.map((input): UpdateTransactionResult => {
      const error = failed.get(input);
      const t = byId.get(input.transaction_id);
      if (error === undefined && t) {
        const ignored =
          input.subtransactions !== undefined
            ? !isSplitTx(t) &&
              "YNAB accepted the row but the transaction did not come back split. Check it in YNAB."
            : input.category_id !== undefined &&
              isSplitTx(t) &&
              "Is a split, so YNAB ignored the category change; the user edits a split's parts in YNAB. Any other fields in this row were applied.";
        if (ignored) {
          return {
            ok: false,
            transaction_id: input.transaction_id,
            error: ignored,
          };
        }
        return {
          ok: true,
          transaction_id: input.transaction_id,
          transaction: t,
        };
      }
      return {
        ok: false,
        transaction_id: input.transaction_id,
        error:
          error ??
          "Not present in YNAB's bulk-update response — id may not exist or may be out of scope.",
      };
    }),
    after: null,
  };
};

const splitRefusal = (
  existing: Transaction,
  subs: UpdateSubInput[],
): string | null => {
  if (isSplitTx(existing)) {
    return "Already a split. YNAB's API cannot change an existing split's parts; the user must edit it in YNAB.";
  }
  const sum = subs.reduce((acc, s) => acc + s.amount_milliunits, 0);
  if (sum !== existing.amount) {
    return `Parts sum to ${sum} milliunits but the transaction is ${existing.amount} (off by ${existing.amount - sum}). The parts must add up exactly; nothing was sent.`;
  }
  return null;
};

// YNAB rejects `subtransactions` on a transaction that is already a split, and
// one bad row can fail the whole bulk PATCH. Splitting is rare, so one GET per
// such input is cheap.
const precheckSplits = async (
  client: YnabClient,
  planId: string,
  inputs: UpdateTransactionInput[],
): Promise<Map<UpdateTransactionInput, string>> => {
  const failed = new Map<UpdateTransactionInput, string>();
  await Promise.all(
    inputs.map(async (input) => {
      const subs = input.subtransactions;
      if (subs === undefined) return;
      try {
        const { data } = await client.getTransaction(
          planId,
          input.transaction_id,
        );
        const refusal = splitRefusal(data.transaction, subs);
        if (refusal) failed.set(input, refusal);
      } catch (e) {
        failed.set(input, errorMessage(e));
      }
    }),
  );
  return failed;
};

export const applyUpdateTransactions = async (
  client: YnabClient,
  planId: string,
  rawInputs: UpdateTransactionInput[],
): Promise<UpdateTransactionsResult> => {
  const named = rawInputs.some(
    (i) =>
      i.category_name !== undefined ||
      i.subtransactions?.some((s) => s.category_name !== undefined),
  );
  const { inputs, failed: unresolved } = named
    ? resolveCategoryNames(
        rawInputs,
        (await client.listCategories(planId)).data.category_groups,
      )
    : { inputs: rawInputs, failed: new Map<UpdateTransactionInput, string>() };
  const failed = await precheckSplits(
    client,
    planId,
    inputs.filter((i) => !unresolved.has(i)),
  );
  for (const [i, e] of unresolved) failed.set(i, e);
  const toSend = inputs.filter((i) => !failed.has(i));
  let updated: Transaction[] = [];
  if (toSend.length > 0) {
    try {
      const resp = await client.updateTransactionsBulk(planId, {
        transactions: toSend.map(buildBulkRow),
      });
      updated = resp.data.transactions;
    } catch (e) {
      const message = errorMessage(e);
      for (const i of toSend) failed.set(i, message);
    }
  }
  const out = interpretBulkResponse(inputs, updated, failed);
  if (!out.results.some((r) => r.ok)) return out;
  try {
    const { data } = await client.getMonth(planId, "current");
    return {
      ...out,
      after: {
        month: data.month.month,
        ready_to_assign: data.month.to_be_budgeted,
        category_balances: touchedBalances(out.results, data.month),
      },
    };
  } catch {
    return out;
  }
};

export const renderUpdateTransactionsResult = (
  out: UpdateTransactionsResult,
  iso: string,
): string => {
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = out.results.length - okCount;
  const header = `## Updated ${okCount} / ${out.results.length} transaction${out.results.length === 1 ? "" : "s"}${errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : ""}`;
  const lines = out.results.flatMap((r) => {
    if (!r.ok) return [`- [error] tx ${r.transaction_id}: ${r.error}`];
    return [
      `- [ok] ${renderTxSummary(r.transaction, iso)} — id ${r.transaction.id}`,
      ...fmtSplitLines(r.transaction, iso),
    ];
  });
  const after = out.after
    ? [
        "",
        `After the update (${out.after.month.slice(0, 7)}): Ready to Assign ${fmtMoney(out.after.ready_to_assign, iso)}`,
        ...out.after.category_balances.map(
          (c) =>
            `- ${c.name}: available ${fmtMoney(c.balance, iso)} (assigned ${fmtMoney(c.budgeted, iso)}, activity ${fmtMoney(c.activity, iso)})`,
        ),
      ]
    : [];
  return [header, ...lines, ...after].join("\n");
};

const renderTxSummary = (t: Transaction, iso: string): string => {
  const payee = t.payee_name ?? "(no payee)";
  const cat = t.category_name ?? "(uncategorized)";
  const approval = t.approved ? "approved" : "unapproved";
  const flag = t.flag_color ? ` [${t.flag_color}]` : "";
  const splitNote =
    t.subtransactions && t.subtransactions.length > 0
      ? ` (${t.subtransactions.length}-way split)`
      : "";
  return `${t.date} ${fmtMoney(t.amount, iso)} ${payee} → ${cat}${splitNote}, ${approval}, ${t.cleared}${flag}`;
};

const DESCRIPTION =
  "Edit one or more existing transactions in one bulk call: categorize, " +
  "approve or unapprove, set the memo or flag, mark cleared or reconciled, " +
  "set the payee, or split a transaction across categories. Send only the " +
  "fields to change; omitted fields stay as they are. `subtransactions` " +
  "splits a transaction in place: it keeps its id, import match, cleared " +
  "and approved state. It only works on a transaction that is NOT already a " +
  "split: leave the parent's `category_id` null or omitted, give each sub " +
  "a signed `amount_milliunits` (outflows negative), and make the subs sum " +
  "exactly to the parent's amount; a mismatch is refused before anything is " +
  "sent. YNAB's API cannot edit an existing split: its parts and the " +
  "parent's category are read-only here, so tell the user to change them in " +
  "YNAB (this tool will not delete and re-create a transaction, which would " +
  "lose its bank import match). The result lists each split's parts. Other " +
  "fields (memo, approval, flag, cleared, payee) still " +
  "work on a split parent. Splits are not allowed on tracking accounts or " +
  "on transfers between on-budget accounts. " +
  "Cannot create or delete transactions or change their date, amount, or " +
  'account. `category_name` ("Groceries" or "Group: Name") may stand in ' +
  "for `category_id`, on the transaction or a split part; a name that matches " +
  "no category or several fails that row before anything is sent. The result " +
  "ends with this month's Ready to Assign and the available balance of each " +
  "category the updated transactions now use. Requires write access; a read-only connection must be " +
  "reconnected to use this tool.";

export const registerUpdateTransactions = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "update_transactions",
    {
      title: "Update Transactions",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        updates: z.array(updateSchema).min(1),
      },
    },
    async ({ plan_id, updates }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const c = getClient();
        const iso = await c.planIso(plan_id);
        const out = await applyUpdateTransactions(c, plan_id, updates);
        return result(renderUpdateTransactionsResult(out, iso), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
