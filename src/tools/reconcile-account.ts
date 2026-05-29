import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Account, Transaction, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import { isTransferTx } from "../predicates";
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

export interface ReconcilePlan {
  accountId: string;
  accountName: string;
  // Link-health fields surfaced from the account (see CONTEXT.md note: YNAB's
  // API does not expose the bank's own balance, only these flags).
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
  plan: ReconcilePlan;
  locked: UpdateTransactionResult[]; // empty unless verified && matches
}

// ---- Compute (pure)

// A transaction is uncategorized (in the blocking sense) when it carries no
// category AND isn't a transfer (transfers legitimately have no category) AND
// isn't a split parent (a split's categories live on its subtransactions).
const isUncategorizedTx = (t: Transaction): boolean =>
  t.category_id == null &&
  !isTransferTx(t) &&
  !(t.subtransactions && t.subtransactions.length > 0);

export const computeReconcilePlan = (
  account: Account,
  transactions: Transaction[],
  statementBalanceMilli: number,
): ReconcilePlan => {
  // Only consider active rows that aren't already locked. Reconciled rows are
  // immutable and were verified when previously locked.
  const active = transactions.filter(
    (t) => !t.deleted && t.cleared !== "reconciled",
  );

  const unverified: Unverified[] = [];
  for (const t of active) {
    if (!t.approved) {
      unverified.push({ tx: t, reason: "unapproved" });
    } else if (isUncategorizedTx(t)) {
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
  budgetId: string,
  plan: ReconcilePlan,
): Promise<ReconcileResult> => {
  // No write unless the account is fully verified, the statement balance
  // matches, and there is actually something to lock.
  if (!plan.verified || !plan.matches || plan.toReconcile.length === 0) {
    return { plan, locked: [] };
  }

  const inputs = plan.toReconcile.map((t) => ({
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
    const resp = await client.updateTransactionsBulk(budgetId, body);
    const out = interpretBulkResponse(inputs, resp.data.transactions);
    return { plan, locked: out.results };
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
      plan,
      locked: plan.toReconcile.map((t) => ({
        ok: false,
        transaction_id: t.id,
        error: message,
      })),
    };
  }
};

// ---- Render (pure)

const fmtHealthHeader = (plan: ReconcilePlan): string => {
  const link = plan.directImportInError
    ? "linked ⚠ (connection error)"
    : plan.directImportLinked
      ? "linked ✓"
      : "not linked";
  const lastRecon = plan.lastReconciledAt
    ? `, last reconciled ${plan.lastReconciledAt.slice(0, 10)}`
    : "";
  return `Account: ${plan.accountName} — ${link}${lastRecon}`;
};

export const renderReconcile = (out: ReconcileResult): string => {
  const { plan } = out;
  const lines: string[] = [fmtHealthHeader(plan), ""];

  // Blocked: unverified transactions take priority over the balance branches.
  if (!plan.verified) {
    const n = plan.unverified.length;
    lines.push(
      `## Cannot reconcile ${plan.accountName} — ${n} transaction${n === 1 ? "" : "s"} need review`,
    );
    lines.push(
      "Reconciliation requires every transaction to be approved and " +
        "categorized. Resolve these (e.g. via triage_inbox + " +
        "update_transactions), then re-run:",
    );
    for (const u of plan.unverified) {
      lines.push(`${fmtTxLine(u.tx, { includeIds: true })} [${u.reason}]`);
    }
    return lines.join("\n");
  }

  // Mismatch: balances disagree — report and list uncleared txns, no write.
  if (!plan.matches) {
    lines.push(
      `## Cannot reconcile ${plan.accountName} — off by ${fmtMoney(plan.delta)}`,
    );
    lines.push(`Statement balance: ${fmtMoney(plan.statementBalance)}`);
    lines.push(`YNAB cleared balance: ${fmtMoney(plan.clearedBalance)}`);
    lines.push(
      "Clear or correct the transactions below so the cleared balance matches " +
        "your statement — or add a reconciliation adjustment in the YNAB app — " +
        "then re-run.",
    );
    if (plan.uncleared.length) {
      lines.push("", `Uncleared transactions (${plan.uncleared.length}):`);
      for (const t of plan.uncleared) {
        lines.push(fmtTxLine(t, { includeIds: true }));
      }
    }
    return lines.join("\n");
  }

  // Verified + matches, but nothing left to lock.
  if (plan.toReconcile.length === 0) {
    lines.push(
      `## ${plan.accountName} already reconciled — nothing to lock`,
    );
    lines.push(
      `Cleared balance ${fmtMoney(plan.clearedBalance)} matches your statement.`,
    );
    return lines.join("\n");
  }

  // Locked.
  const okCount = out.locked.filter((r) => r.ok).length;
  const errCount = out.locked.length - okCount;
  lines.push(
    `## Reconciled ${plan.accountName} — locked ${okCount} / ${out.locked.length} transaction${out.locked.length === 1 ? "" : "s"}${errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : ""}`,
  );
  lines.push(
    `Cleared balance ${fmtMoney(plan.clearedBalance)} matches your statement.`,
  );
  for (const r of out.locked) {
    if (!r.ok) {
      lines.push(`- [error] tx ${r.transaction_id}: ${r.error}`);
    } else {
      lines.push(`- [ok] ${fmtTxLine(r.transaction, { includeIds: true })}`);
    }
  }
  return lines.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Reconcile a YNAB account against a bank statement. Provide the account's " +
  "real cleared balance (from your statement) in milliunits. Reconciliation " +
  "only proceeds when EVERY active transaction in the account is approved and " +
  "categorized — otherwise it makes no changes and lists what needs review. " +
  "When the statement balance equals YNAB's cleared balance, every cleared " +
  "transaction is locked as `reconciled`. When the balances differ, nothing is " +
  "written and the discrepancy plus uncleared transactions are reported (this " +
  "tool cannot create the YNAB balance-adjustment transaction — do that in the " +
  "YNAB app). Note: YNAB's API does not expose the linked bank's own balance, " +
  "so you must supply the statement balance. Requires write access — " +
  "connections granted read-only must be reconnected to enable this tool.";

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
        budget_id: z.string(),
        account_id: z.string(),
        statement_balance_milliunits: z.number().int(),
      },
    },
    async ({ budget_id, account_id, statement_balance_milliunits }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const client = getClient();
        const [accountRes, txRes] = await Promise.all([
          client.getAccount(budget_id, account_id),
          client.listAccountTransactions(budget_id, account_id),
        ]);
        const plan = computeReconcilePlan(
          accountRes.data.account,
          txRes.data.transactions,
          statement_balance_milliunits,
        );
        const out = await applyReconcile(client, budget_id, plan);
        return result(renderReconcile(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
