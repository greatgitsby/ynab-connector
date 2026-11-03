import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Account, Transaction, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import { isSplitTx, isTrackingAccount, isTransferTx } from "../predicates";
import {
  fmtMoney,
  fmtTxLine,
  handleError,
  result,
  scopeDeniedError,
} from "../format";
import { interpretBulkResponse } from "./update-transactions";
import type { UpdateTransactionResult } from "./update-transactions";
import type { Props } from "../ynab-auth";

// ---- Result types (the test surface)

export interface Unverified {
  tx: Transaction;
  reason: "unapproved" | "uncategorized";
}

export interface Reconciliation {
  accountId: string;
  accountName: string;
  // Link-health fields surfaced from the account. YNAB's
  // API does not expose the bank's own balance, only these flags.
  directImportLinked: boolean;
  directImportInError: boolean;
  lastReconciledAt: string | null;
  clearedBalance: number;
  statementBalance: number;
  delta: number; // statementBalance - clearedBalance
  verified: boolean; // false when any unverified tx exists
  unverified: Unverified[]; // blockers (empty when verified)
  matches: boolean; // only meaningful when verified
  toReconcile: Transaction[]; // cleared & not reconciled (only when verified && matches)
  uncleared: Transaction[]; // for the mismatch report
}

export interface ReconcileResult {
  reconciliation: Reconciliation;
  locked: UpdateTransactionResult[]; // empty unless verified && matches
}

// ---- Compute (pure)

// A transaction is uncategorized (in the blocking sense) when it carries no
// category AND isn't a transfer (transfers legitimately have no category) AND
// isn't a split parent (a split's categories live on its subtransactions).
const isUncategorizedTx = (t: Transaction): boolean =>
  t.category_id == null &&
  !isTransferTx(t) &&
  !isSplitTx(t);

export const computeReconciliation = (
  account: Account,
  transactions: Transaction[],
  statementBalanceMilli: number,
): Reconciliation => {
  // Only consider active rows that aren't already locked. Reconciled rows are
  // immutable and were verified when previously locked.
  const active = transactions.filter(
    (t) => !t.deleted && t.cleared !== "reconciled",
  );

  // Tracking (off-budget) accounts never take categories, so only approval
  // gates them.
  const needsCategory = !isTrackingAccount(account);
  const unverified: Unverified[] = [];
  for (const t of active) {
    if (!t.approved) {
      unverified.push({ tx: t, reason: "unapproved" });
    } else if (needsCategory && isUncategorizedTx(t)) {
      unverified.push({ tx: t, reason: "uncategorized" });
    }
  }

  const delta = statementBalanceMilli - account.cleared_balance;

  return {
    accountId: account.id,
    accountName: account.name,
    directImportLinked: account.direct_import_linked ?? false,
    directImportInError: account.direct_import_in_error ?? false,
    lastReconciledAt: account.last_reconciled_at ?? null,
    clearedBalance: account.cleared_balance,
    statementBalance: statementBalanceMilli,
    delta,
    verified: unverified.length === 0,
    unverified,
    matches: delta === 0,
    toReconcile: active.filter((t) => t.cleared === "cleared"),
    uncleared: active.filter((t) => t.cleared === "uncleared"),
  };
};

// ---- Effectful: lock cleared transactions only when verified && matches

export const applyReconcile = async (
  client: YnabClient,
  planId: string,
  reconciliation: Reconciliation,
): Promise<ReconcileResult> => {
  // No write unless the account is fully verified, the statement balance
  // matches, and there is actually something to lock.
  if (!reconciliation.verified || !reconciliation.matches || reconciliation.toReconcile.length === 0) {
    return { reconciliation, locked: [] };
  }

  const inputs = reconciliation.toReconcile.map((t) => ({
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
    return { reconciliation, locked: out.results };
  } catch (e) {
    // Whole-batch failure (401, 5xx, ...) — surface as per-item errors so the
    // response shape is stable.
    const message =
      e instanceof YnabError
        ? `YNAB ${e.status}: ${e.body}`
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      reconciliation,
      locked: reconciliation.toReconcile.map((t) => ({
        ok: false,
        transaction_id: t.id,
        error: message,
      })),
    };
  }
};

// ---- Render (pure)

const fmtHealthHeader = (reconciliation: Reconciliation): string => {
  const link = reconciliation.directImportInError
    ? "linked ⚠ (connection error)"
    : reconciliation.directImportLinked
      ? "linked ✓"
      : "not linked";
  const lastRecon = reconciliation.lastReconciledAt
    ? `, last reconciled ${reconciliation.lastReconciledAt.slice(0, 10)}`
    : "";
  return `Account: ${reconciliation.accountName} — ${link}${lastRecon}`;
};

export const renderReconcile = (out: ReconcileResult, iso: string): string => {
  const { reconciliation } = out;
  const lines: string[] = [fmtHealthHeader(reconciliation), ""];

  // Blocked: unverified transactions take priority over the balance branches.
  if (!reconciliation.verified) {
    const n = reconciliation.unverified.length;
    lines.push(
      `## Cannot reconcile ${reconciliation.accountName} — ${n} transaction${n === 1 ? "" : "s"} need review`,
    );
    lines.push(
      "Reconciliation requires every transaction to be approved and " +
        "categorized. Fix these (for example with triage_inbox and " +
        "update_transactions), then run this again:",
    );
    for (const u of reconciliation.unverified) {
      lines.push(`${fmtTxLine(u.tx, iso, { includeIds: true })} [${u.reason}]`);
    }
    return lines.join("\n");
  }

  // Mismatch: balances disagree — report and list uncleared txns, no write.
  if (!reconciliation.matches) {
    lines.push(
      `## Cannot reconcile ${reconciliation.accountName} — off by ${fmtMoney(reconciliation.delta, iso)}`,
    );
    lines.push(`Statement balance: ${fmtMoney(reconciliation.statementBalance, iso)}`);
    lines.push(`YNAB cleared balance: ${fmtMoney(reconciliation.clearedBalance, iso)}`);
    lines.push(
      "Clear or correct the transactions below until the cleared balance " +
        "matches your statement, or add a reconciliation adjustment in the " +
        "YNAB app. Then run this again.",
    );
    if (reconciliation.uncleared.length) {
      lines.push("", `Uncleared transactions (${reconciliation.uncleared.length}):`);
      for (const t of reconciliation.uncleared) {
        lines.push(fmtTxLine(t, iso, { includeIds: true }));
      }
    }
    return lines.join("\n");
  }

  // Verified + matches, but nothing left to lock.
  if (reconciliation.toReconcile.length === 0) {
    lines.push(
      `## ${reconciliation.accountName} already reconciled — nothing to lock`,
    );
    lines.push(
      `Cleared balance ${fmtMoney(reconciliation.clearedBalance, iso)} matches your statement.`,
    );
    return lines.join("\n");
  }

  // Locked.
  const okCount = out.locked.filter((r) => r.ok).length;
  const errCount = out.locked.length - okCount;
  lines.push(
    `## Reconciled ${reconciliation.accountName} — locked ${okCount} / ${out.locked.length} transaction${out.locked.length === 1 ? "" : "s"}${errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : ""}`,
  );
  lines.push(
    `Cleared balance ${fmtMoney(reconciliation.clearedBalance, iso)} matches your statement.`,
  );
  for (const r of out.locked) {
    if (!r.ok) {
      lines.push(`- [error] tx ${r.transaction_id}: ${r.error}`);
    } else {
      lines.push(`- [ok] ${fmtTxLine(r.transaction, iso, { includeIds: true })}`);
    }
  }
  return lines.join("\n");
};

// ---- MCP tool registration

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
