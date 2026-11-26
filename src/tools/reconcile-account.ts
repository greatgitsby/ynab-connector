import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Account, Transaction, YnabClient } from "../ynab";
import { TransactionSchema } from "../wire";
import { isSplitTx, isTrackingAccount, isTransferTx } from "../predicates";
import {
  fmtMoney,
  fmtTxLine,
  handleError,
  result,
  scopeDeniedError,
  errorMessage,
} from "../format";
import { interpretBulkResponse } from "./update-transactions";
import type { Props } from "../ynab-auth";

const AccountHealthSchema = z.object({
  account_id: z.string(),
  account_name: z.string(),
  direct_import_linked: z.boolean(),
  direct_import_in_error: z.boolean(),
  last_reconciled_at: z.string().nullable(),
  cleared_balance: z.number().int(),
  statement_balance: z.number().int(),
});

const UnverifiedSchema = z.object({
  transaction: TransactionSchema,
  reason: z.enum(["unapproved", "uncategorized"]),
});
type Unverified = z.infer<typeof UnverifiedSchema>;

const LockResultSchema = z.discriminatedUnion("ok", [
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

const BlockedSchema = AccountHealthSchema.extend({
  status: z.literal("blocked"),
  unverified: z.array(UnverifiedSchema),
});
const MismatchSchema = AccountHealthSchema.extend({
  status: z.literal("mismatch"),
  delta: z.number().int(),
  uncleared: z.array(TransactionSchema),
});
const NothingToLockSchema = AccountHealthSchema.extend({
  status: z.literal("nothing_to_lock"),
});
const ReadySchema = AccountHealthSchema.extend({
  status: z.literal("ready"),
  to_reconcile: z.array(TransactionSchema),
});
const LockedSchema = AccountHealthSchema.extend({
  status: z.literal("locked"),
  locked: z.array(LockResultSchema),
});

export const ReconciliationSchema = z.discriminatedUnion("status", [
  BlockedSchema,
  MismatchSchema,
  NothingToLockSchema,
  ReadySchema,
]);
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

export const ReconcileResultSchema = z.discriminatedUnion("status", [
  BlockedSchema,
  MismatchSchema,
  NothingToLockSchema,
  LockedSchema,
]);
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;
type AccountHealth = z.infer<typeof AccountHealthSchema>;

const isUncategorizedTx = (t: Transaction): boolean =>
  t.category_id == null && !isTransferTx(t) && !isSplitTx(t);

export const computeReconciliation = (
  account: Account,
  transactions: Transaction[],
  statementBalanceMilli: number,
): Reconciliation => {
  const active = transactions.filter(
    (t) => !t.deleted && t.cleared !== "reconciled",
  );

  const needsCategory = !isTrackingAccount(account);
  const unverified: Unverified[] = [];
  for (const t of active) {
    if (!t.approved) {
      unverified.push({ transaction: t, reason: "unapproved" });
    } else if (needsCategory && isUncategorizedTx(t)) {
      unverified.push({ transaction: t, reason: "uncategorized" });
    }
  }

  const health: AccountHealth = {
    account_id: account.id,
    account_name: account.name,
    direct_import_linked: account.direct_import_linked ?? false,
    direct_import_in_error: account.direct_import_in_error ?? false,
    last_reconciled_at: account.last_reconciled_at ?? null,
    cleared_balance: account.cleared_balance,
    statement_balance: statementBalanceMilli,
  };

  if (unverified.length) return { ...health, status: "blocked", unverified };

  const delta = statementBalanceMilli - account.cleared_balance;
  if (delta !== 0) {
    return {
      ...health,
      status: "mismatch",
      delta,
      uncleared: active.filter((t) => t.cleared === "uncleared"),
    };
  }

  const toReconcile = active.filter((t) => t.cleared === "cleared");
  if (!toReconcile.length) return { ...health, status: "nothing_to_lock" };
  return { ...health, status: "ready", to_reconcile: toReconcile };
};

export const applyReconcile = async (
  client: YnabClient,
  planId: string,
  reconciliation: Reconciliation,
): Promise<ReconcileResult> => {
  switch (reconciliation.status) {
    case "blocked":
    case "mismatch":
    case "nothing_to_lock":
      return reconciliation;
    case "ready": {
      const { status: _, to_reconcile, ...health } = reconciliation;
      const inputs = to_reconcile.map((t) => ({
        transaction_id: t.id,
        cleared: "reconciled" as const,
      }));
      const body = {
        transactions: inputs.map((i) => ({
          id: i.transaction_id,
          cleared: i.cleared,
        })),
      };
      try {
        const resp = await client.updateTransactionsBulk(planId, body);
        const out = interpretBulkResponse(inputs, resp.data.transactions);
        return { ...health, status: "locked", locked: out.results };
      } catch (e) {
        const message = errorMessage(e);
        return {
          ...health,
          status: "locked",
          locked: to_reconcile.map((t) => ({
            ok: false,
            transaction_id: t.id,
            error: message,
          })),
        };
      }
    }
  }
};

const fmtHealthHeader = (r: AccountHealth): string => {
  const link = r.direct_import_in_error
    ? "linked ⚠ (connection error)"
    : r.direct_import_linked
      ? "linked ✓"
      : "not linked";
  const lastRecon = r.last_reconciled_at
    ? `, last reconciled ${r.last_reconciled_at.slice(0, 10)}`
    : "";
  return `Account: ${r.account_name} — ${link}${lastRecon}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const renderBody = (out: ReconcileResult, iso: string): string[] => {
  switch (out.status) {
    case "blocked":
      return [
        `## Cannot reconcile ${out.account_name} — ${plural(out.unverified.length, "transaction")} need review`,
        "Reconciliation requires every transaction to be approved and " +
          "categorized. Fix these (for example with triage_inbox and " +
          "update_transactions), then run this again:",
        ...out.unverified.map(
          (u) =>
            `${fmtTxLine(u.transaction, iso, { includeIds: true })} [${u.reason}]`,
        ),
      ];
    case "mismatch":
      return [
        `## Cannot reconcile ${out.account_name} — off by ${fmtMoney(out.delta, iso)}`,
        `Statement balance: ${fmtMoney(out.statement_balance, iso)}`,
        `YNAB cleared balance: ${fmtMoney(out.cleared_balance, iso)}`,
        "Clear or correct the transactions below until the cleared balance " +
          "matches your statement, or add a reconciliation adjustment in the " +
          "YNAB app. Then run this again.",
        ...(out.uncleared.length
          ? [
              "",
              `Uncleared transactions (${out.uncleared.length}):`,
              ...out.uncleared.map((t) =>
                fmtTxLine(t, iso, { includeIds: true }),
              ),
            ]
          : []),
      ];
    case "nothing_to_lock":
      return [
        `## ${out.account_name} already reconciled — nothing to lock`,
        `Cleared balance ${fmtMoney(out.cleared_balance, iso)} matches your statement.`,
      ];
    case "locked": {
      const okCount = out.locked.filter((r) => r.ok).length;
      const errCount = out.locked.length - okCount;
      return [
        `## Reconciled ${out.account_name} — locked ${okCount} / ${plural(out.locked.length, "transaction")}${errCount ? ` (${plural(errCount, "error")})` : ""}`,
        `Cleared balance ${fmtMoney(out.cleared_balance, iso)} matches your statement.`,
        ...out.locked.map((r) =>
          r.ok
            ? `- [ok] ${fmtTxLine(r.transaction, iso, { includeIds: true })}`
            : `- [error] tx ${r.transaction_id}: ${r.error}`,
        ),
      ];
    }
  }
};

export const renderReconcile = (out: ReconcileResult, iso: string): string =>
  [fmtHealthHeader(out), "", ...renderBody(out, iso)].join("\n");

const DESCRIPTION =
  "Reconcile a YNAB account against a bank statement. Pass the cleared " +
  "balance from the statement, in milliunits. YNAB's API does not expose the " +
  "linked bank's balance, so the statement is the only source for it. The " +
  "tool reconciles only when EVERY active transaction in the account is " +
  "approved and categorized; otherwise it changes nothing and lists what " +
  "needs review. If the statement balance equals YNAB's cleared balance, it " +
  "locks every cleared transaction as `reconciled`. If they differ, it writes " +
  "nothing and reports the difference and the uncleared transactions. It " +
  "cannot create YNAB's balance-adjustment transaction; the user does that in " +
  "the YNAB app. Requires write access; a read-only connection must be " +
  "reconnected to use this tool.";

export const registerReconcileAccount = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "reconcile_account",
    {
      title: "Reconcile Account",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        account_id: z.string(),
        statement_balance_milliunits: z.number().int(),
      },
    },
    async ({ plan_id, account_id, statement_balance_milliunits }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const client = getClient();
        const [accountRes, txRes, iso] = await Promise.all([
          client.getAccount(plan_id, account_id),
          client.listTransactions(plan_id, { accountId: account_id }),
          client.planIso(plan_id),
        ]);
        const reconciliation = computeReconciliation(
          accountRes.data.account,
          txRes.data.transactions,
          statement_balance_milliunits,
        );
        const out = await applyReconcile(client, plan_id, reconciliation);
        return result(renderReconcile(out, iso), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
