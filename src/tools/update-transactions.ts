import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  CategoryGroup,
  MonthDetail,
  SaveSubTransaction,
  SaveTransactionWithId,
  Transaction,
  YnabClient,
} from "../ynab";
import { YnabError } from "../ynab";
import {
  fmtMoney,
  fmtSplitLines,
  handleError,
  result,
  scopeDeniedError,
} from "../format";
import type { Props } from "../ynab-auth";
import { isSplitTx } from "../predicates";
import { categoryRefs, resolveOne } from "../resolve";

// ---- Input + Result types

export interface UpdateSubInput {
  amount_milliunits: number;
  category_id?: string | null;
  // Resolved to category_id before sending.
  category_name?: string;
  memo?: string | null;
  payee_name?: string;
  payee_id?: string;
}

export interface UpdateTransactionInput {
  transaction_id: string;
  category_id?: string | null;
  // Resolved to category_id before sending.
  category_name?: string;
  payee_name?: string;
  payee_id?: string;
  memo?: string | null;
  approved?: boolean;
  cleared?: "cleared" | "uncleared" | "reconciled";
  flag_color?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | null;
  subtransactions?: UpdateSubInput[];
}

export interface UpdateTransactionOk {
  ok: true;
  transaction_id: string;
  transaction: Transaction;
}

export interface UpdateTransactionError {
  ok: false;
  transaction_id: string;
  error: string;
}

export type UpdateTransactionResult = UpdateTransactionOk | UpdateTransactionError;

export interface CategoryBalance {
  id: string;
  name: string;
  budgeted: number;
  activity: number;
  balance: number;
}

export interface UpdateTransactionsResult {
  results: UpdateTransactionResult[];
  // The current month's state after the write, for the categories the
  // updated transactions now sit in. Absent when nothing was written or the
  // re-read failed.
  month?: string;
  ready_to_assign?: number;
  category_balances?: CategoryBalance[];
}

// Replaces each category_name with the id it names. An input whose name
// matches no category, or several, fails on its own before anything is sent.
export const resolveCategoryNames = (
  inputs: UpdateTransactionInput[],
  groups: CategoryGroup[],
): { inputs: UpdateTransactionInput[]; failed: Map<UpdateTransactionInput, string> } => {
  const refs = categoryRefs(groups);
  const failed = new Map<UpdateTransactionInput, string>();
  const resolved = inputs.map((input) => {
    const errors: string[] = [];
    const lookup = (name: string | undefined, id: string | null | undefined) => {
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
      out.subtransactions = input.subtransactions.map(({ category_name: n, ...sub }) => {
        const id = lookup(n, sub.category_id);
        return id !== undefined ? { ...sub, category_id: id } : sub;
      });
    }
    if (errors.length) failed.set(out, errors.join(" "));
    return out;
  });
  return { inputs: resolved, failed };
};

// The month's categories that updated transactions (or their parts) now use.
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

// ---- Compute: input → wire body (pure)

// Builds the bulk PATCH row from a tool-shaped input. Strips undefined keys
// so the request only carries fields the caller actually wanted to change
// (YNAB treats omitted fields as unchanged).
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

// ---- Compute: response → per-input result (pure)

// YNAB's bulk PATCH response includes the updated transactions in arbitrary
// order. Failed rows are NOT in the response, so an input missing from it gets
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
          return { ok: false, transaction_id: input.transaction_id, error: ignored };
        }
        return { ok: true, transaction_id: input.transaction_id, transaction: t };
      }
      return {
        ok: false,
        transaction_id: input.transaction_id,
        error:
          error ??
          "Not present in YNAB's bulk-update response — id may not exist or may be out of scope.",
      };
    }),
  };
};

// ---- Effectful: split precheck, then one bulk PATCH

const errorMessage = (e: unknown): string =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

// Why a split input can't be sent, or null if it can. The parts must sum to the
// parent exactly; a split that has already been split can't be split again.
export const splitRefusal = (
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
    inputs
      .filter((i) => i.subtransactions !== undefined)
      .map(async (input) => {
        try {
          const { data } = await client.getTransaction(planId, input.transaction_id);
          const refusal = splitRefusal(data.transaction, input.subtransactions!);
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
    (i) => i.category_name !== undefined || i.subtransactions?.some((s) => s.category_name !== undefined),
  );
  const { inputs, failed: unresolved } = named
    ? resolveCategoryNames(rawInputs, (await client.listCategories(planId)).data.category_groups)
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
      // Whole-batch failure (e.g., 401, 5xx): every sent input gets the error.
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
      month: data.month.month,
      ready_to_assign: data.month.to_be_budgeted,
      category_balances: touchedBalances(out.results, data.month),
    };
  } catch {
    return out;
  }
};

// ---- Render (pure)

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
  const after = out.ready_to_assign != null
    ? [
        "",
        `After the update (${out.month?.slice(0, 7)}): Ready to Assign ${fmtMoney(out.ready_to_assign ?? 0, iso)}`,
        ...(out.category_balances ?? []).map(
          (c) => `- ${c.name}: available ${fmtMoney(c.balance, iso)} (assigned ${fmtMoney(c.budgeted, iso)}, activity ${fmtMoney(c.activity, iso)})`,
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

// ---- MCP tool registration

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
  "account. `category_name` (\"Groceries\" or \"Group: Name\") may stand in " +
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
  const flagColors = ["red", "orange", "yellow", "green", "blue", "purple"] as const;

  const subSchema = z.object({
    amount_milliunits: z.number().int(),
    category_id: z.string().nullable().optional(),
    category_name: z.string().optional(),
    memo: z.string().nullable().optional(),
    payee_name: z.string().optional(),
    payee_id: z.string().optional(),
  });

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
      flag_color: z.enum(flagColors).nullable().optional(),
      subtransactions: z.array(subSchema).optional(),
    })
    .refine((v) => !(v.category_id !== undefined && v.category_name !== undefined), {
      message: "Give category_id or category_name, not both.",
      path: ["category_name"],
    })
    .refine(
      (v) => !(v.subtransactions && (v.category_id != null || v.category_name !== undefined)),
      {
        message:
          "When `subtransactions` is set, the parent's `category_id` must be null or omitted.",
        path: ["category_id"],
      },
    );

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
