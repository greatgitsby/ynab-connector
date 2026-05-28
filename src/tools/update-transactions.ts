import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  SaveSubTransaction,
  SaveTransactionWithId,
  Transaction,
  YnabClient,
} from "../ynab";
import { YnabError } from "../ynab";
import {
  fmtMoney,
  handleError,
  result,
  scopeDeniedError,
} from "../format";
import type { Props } from "../ynab-auth";

// ---- Input + Result types

export interface UpdateSubInput {
  amount_milliunits: number;
  category_id?: string | null;
  memo?: string | null;
  payee_name?: string;
  payee_id?: string;
}

export interface UpdateTransactionInput {
  transaction_id: string;
  category_id?: string | null;
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

export interface UpdateTransactionsResult {
  results: UpdateTransactionResult[];
}

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
// order. `transaction_ids` carries every id that was successfully updated
// (including subtransaction ids — we filter to parent ids by looking them up
// against the input set). Failed rows are NOT in the response; for those we
// surface a generic error so the caller knows which inputs missed.
export const interpretBulkResponse = (
  inputs: UpdateTransactionInput[],
  updatedTransactions: Transaction[],
): UpdateTransactionsResult => {
  const byId = new Map(updatedTransactions.map((t) => [t.id, t]));
  return {
    results: inputs.map((input) => {
      const t = byId.get(input.transaction_id);
      if (t) {
        return { ok: true, transaction_id: input.transaction_id, transaction: t };
      }
      return {
        ok: false,
        transaction_id: input.transaction_id,
        error:
          "Not present in YNAB's bulk-update response — id may not exist or may be out of scope.",
      };
    }),
  };
};

// ---- Effectful: one bulk PATCH per call

export const applyUpdateTransactions = async (
  client: YnabClient,
  budgetId: string,
  inputs: UpdateTransactionInput[],
): Promise<UpdateTransactionsResult> => {
  const body = { transactions: inputs.map(buildBulkRow) };
  try {
    const resp = await client.updateTransactionsBulk(budgetId, body);
    return interpretBulkResponse(inputs, resp.data.transactions);
  } catch (e) {
    // Whole-batch failure (e.g., 401, 5xx) — surface as a per-item error so
    // the response shape is stable.
    const message =
      e instanceof YnabError
        ? `YNAB ${e.status}: ${e.body}`
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      results: inputs.map((input) => ({
        ok: false,
        transaction_id: input.transaction_id,
        error: message,
      })),
    };
  }
};

// ---- Render (pure)

export const renderUpdateTransactionsResult = (
  out: UpdateTransactionsResult,
): string => {
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = out.results.length - okCount;
  const header = `## Updated ${okCount} / ${out.results.length} transaction${out.results.length === 1 ? "" : "s"}${errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : ""}`;
  const lines = out.results.map((r) => {
    if (!r.ok) return `- [error] tx ${r.transaction_id}: ${r.error}`;
    return `- [ok] ${renderTxSummary(r.transaction)} — id ${r.transaction.id}`;
  });
  return [header, ...lines].join("\n");
};

const renderTxSummary = (t: Transaction): string => {
  const payee = t.payee_name ?? "(no payee)";
  const cat = t.category_name ?? "(uncategorized)";
  const approval = t.approved ? "approved" : "unapproved";
  const flag = t.flag_color ? ` [${t.flag_color}]` : "";
  const splitNote =
    t.subtransactions && t.subtransactions.length > 0
      ? ` (${t.subtransactions.length}-way split)`
      : "";
  return `${t.date} ${fmtMoney(t.amount)} ${payee} → ${cat}${splitNote}, ${approval}, ${t.cleared}${flag}`;
};

// ---- MCP tool registration

const DESCRIPTION =
  "Edit one or more existing transactions in a single bulk call. Use this " +
  "to categorize, approve, memo, flag, mark cleared/reconciled, set a " +
  "payee, or split a transaction across multiple categories. Provide only " +
  "the fields you want to change — omitted fields are left unchanged. " +
  "Splits: when `subtransactions` is set, the parent's `category_id` must " +
  "be null/omitted, each sub requires `amount_milliunits`, and sub-amounts " +
  "should sum to the parent's amount (YNAB enforces this). YNAB's split " +
  "semantics REPLACE the whole subtransactions array — to edit one sub of " +
  "a 3-way split, send all 3 subs. Cannot create, delete, or change a " +
  "transaction's date/amount/account. Requires write access — connections " +
  "granted read-only must be reconnected to enable this tool.";

export const registerUpdateTransactions = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  const flagColors = ["red", "orange", "yellow", "green", "blue", "purple"] as const;

  const subSchema = z.object({
    amount_milliunits: z.number().int(),
    category_id: z.string().nullable().optional(),
    memo: z.string().nullable().optional(),
    payee_name: z.string().optional(),
    payee_id: z.string().optional(),
  });

  const updateSchema = z
    .object({
      transaction_id: z.string(),
      category_id: z.string().nullable().optional(),
      payee_name: z.string().optional(),
      payee_id: z.string().optional(),
      memo: z.string().nullable().optional(),
      approved: z.boolean().optional(),
      cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional(),
      flag_color: z.enum(flagColors).nullable().optional(),
      subtransactions: z.array(subSchema).optional(),
    })
    .refine(
      (v) => !(v.subtransactions && v.category_id != null),
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
        budget_id: z.string(),
        updates: z.array(updateSchema).min(1),
      },
    },
    async ({ budget_id, updates }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const out = await applyUpdateTransactions(
          getClient(),
          budget_id,
          updates,
        );
        return result(renderUpdateTransactionsResult(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
