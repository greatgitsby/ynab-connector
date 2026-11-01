import { describe, test, expect, vi } from "vitest";
import {
  YnabError,
  type Account,
  type Transaction,
  type YnabClient,
} from "../ynab";
import {
  applyReconcile,
  computeReconciliation,
  renderReconcile,
} from "./reconcile-account";

const account = (over: Partial<Account>): Account => ({
  id: "acc-1",
  name: "Checking",
  type: "checking",
  on_budget: true,
  closed: false,
  transfer_payee_id: null,
  deleted: false,
  balance: 1_000_000,
  cleared_balance: 950_000,
  uncleared_balance: 50_000,
  ...over,
});

const tx = (over: Partial<Transaction> & { id: string }): Transaction =>
  ({
    date: "2026-05-15",
    amount: -10_000,
    memo: null,
    cleared: "cleared",
    approved: true,
    account_id: "acc-1",
    account_name: "Checking",
    payee_id: null,
    payee_name: "Store",
    category_id: "cat-1",
    category_name: "Groceries",
    flag_color: null,
    transfer_account_id: null,
    deleted: false,
    ...over,
  }) as Transaction;

describe("computeReconciliation", () => {
  test("verified + matching: only cleared (non-reconciled) txns are lockable", () => {
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [
        tx({ id: "c1", cleared: "cleared" }),
        tx({ id: "c2", cleared: "cleared" }),
        tx({ id: "u1", cleared: "uncleared" }),
        tx({ id: "r1", cleared: "reconciled" }),
      ],
      950_000,
    );
    expect(reconciliation.verified).toBe(true);
    expect(reconciliation.matches).toBe(true);
    expect(reconciliation.delta).toBe(0);
    expect(reconciliation.toReconcile.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(reconciliation.uncleared.map((t) => t.id)).toEqual(["u1"]);
  });

  test("mismatch: matches=false, signed delta, uncleared listed", () => {
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "u1", cleared: "uncleared" })],
      900_000,
    );
    expect(reconciliation.matches).toBe(false);
    expect(reconciliation.delta).toBe(-50_000); // statement - cleared
    expect(reconciliation.uncleared.map((t) => t.id)).toEqual(["u1"]);
  });

  test("tracking accounts: missing categories don't block, unapproved still does", () => {
    const tracking = account({ type: "otherAsset", on_budget: false });
    const uncat = tx({ id: "u", category_id: null, category_name: null });
    expect(computeReconciliation(tracking, [uncat], 950_000).verified).toBe(true);
    const r = computeReconciliation(
      tracking,
      [uncat, tx({ id: "p", category_id: null, approved: false })],
      950_000,
    );
    expect(r.unverified.map((u) => [u.tx.id, u.reason])).toEqual([["p", "unapproved"]]);
  });

  test("unapproved and uncategorized txns block; transfers and splits don't", () => {
    const reconciliation = computeReconciliation(
      account({}),
      [
        tx({ id: "unappr", approved: false }),
        tx({ id: "uncat", category_id: null }),
        // transfer with null category — allowed
        tx({ id: "xfer", category_id: null, transfer_account_id: "acc-2" }),
        // split parent: null category but has subtransactions — allowed
        tx({
          id: "split",
          category_id: null,
          subtransactions: [
            {
              id: "s1",
              transaction_id: "split",
              deleted: false,
              amount: -5_000,
              memo: null,
              payee_id: null,
              payee_name: null,
              category_id: "cat-a",
              category_name: "A",
            },
          ],
        }),
      ],
      950_000,
    );
    expect(reconciliation.verified).toBe(false);
    expect(
      reconciliation.unverified.map((u) => [u.tx.id, u.reason]),
    ).toEqual([
      ["unappr", "unapproved"],
      ["uncat", "uncategorized"],
    ]);
  });

  test("already-reconciled and deleted rows are ignored for verification", () => {
    const reconciliation = computeReconciliation(
      account({}),
      [
        tx({ id: "r1", cleared: "reconciled", approved: false }),
        tx({ id: "d1", deleted: true, approved: false }),
      ],
      950_000,
    );
    expect(reconciliation.verified).toBe(true);
    expect(reconciliation.toReconcile).toHaveLength(0);
  });

  test("surfaces link-health fields from the account", () => {
    const reconciliation = computeReconciliation(
      account({
        direct_import_linked: true,
        direct_import_in_error: true,
        last_reconciled_at: "2026-04-30T00:00:00+00:00",
      }),
      [],
      950_000,
    );
    expect(reconciliation.directImportLinked).toBe(true);
    expect(reconciliation.directImportInError).toBe(true);
    expect(reconciliation.lastReconciledAt).toBe("2026-04-30T00:00:00+00:00");
  });
});

describe("applyReconcile", () => {
  const stub = (
    responder: (body: unknown) => Transaction[] | YnabError,
  ): {
    client: Pick<YnabClient, "updateTransactionsBulk">;
    bodies: unknown[];
  } => {
    const bodies: unknown[] = [];
    const updateTransactionsBulk = vi.fn(
      async (_planId: string, body: unknown) => {
        bodies.push(body);
        const r = responder(body);
        if (r instanceof YnabError) throw r;
        return {
          data: { transactions: r, transaction_ids: r.map((t) => t.id) },
        };
      },
    );
    return {
      client: {
        updateTransactionsBulk,
      } as Pick<YnabClient, "updateTransactionsBulk">,
      bodies,
    };
  };

  test("verified+match: PATCHes only {id, cleared: reconciled} rows", async () => {
    const { client, bodies } = stub(() => [
      tx({ id: "c1", cleared: "reconciled" }),
      tx({ id: "c2", cleared: "reconciled" }),
    ]);
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" }), tx({ id: "c2" })],
      950_000,
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", reconciliation);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      transactions: [
        { id: "c1", cleared: "reconciled" },
        { id: "c2", cleared: "reconciled" },
      ],
    });
    expect(out.locked.map((r) => r.ok)).toEqual([true, true]);
  });

  test("mismatch: no YNAB call, nothing locked", async () => {
    const { client, bodies } = stub(() => []);
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" })],
      900_000, // mismatch
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", reconciliation);

    expect(bodies).toHaveLength(0);
    expect(out.locked).toHaveLength(0);
  });

  test("unverified: no YNAB call even when the balance would match", async () => {
    const { client, bodies } = stub(() => []);
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1", approved: false })], // unverified
      950_000, // would match
    );
    expect(reconciliation.matches).toBe(true);

    const out = await applyReconcile(client as YnabClient, "bud-1", reconciliation);

    expect(bodies).toHaveLength(0);
    expect(out.locked).toHaveLength(0);
  });

  test("nothing to lock: no YNAB call", async () => {
    const { client, bodies } = stub(() => []);
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "u1", cleared: "uncleared" })],
      950_000,
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", reconciliation);

    expect(bodies).toHaveLength(0);
    expect(out.locked).toHaveLength(0);
  });

  test("whole-batch YnabError surfaces as per-item errors", async () => {
    const { client } = stub(() => new YnabError(401, "expired"));
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" }), tx({ id: "c2" })],
      950_000,
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", reconciliation);

    expect(out.locked.map((r) => r.ok)).toEqual([false, false]);
    if (!out.locked[0].ok) {
      expect(out.locked[0].error).toBe("YNAB 401: expired");
    }
  });
});

describe("renderReconcile", () => {
  const reconciliationFor = (
    acc: Partial<Account>,
    txns: Transaction[],
    statement: number,
  ) => computeReconciliation(account(acc), txns, statement);

  test("blocked branch lists offenders with reasons", () => {
    const reconciliation = reconciliationFor({}, [
      tx({ id: "unappr", approved: false }),
      tx({ id: "uncat", category_id: null }),
    ], 950_000);
    const out = renderReconcile({ reconciliation, locked: [] }, "USD");
    expect(out).toContain("Cannot reconcile Checking — 2 transactions need review");
    expect(out).toContain("[unapproved]");
    expect(out).toContain("[uncategorized]");
  });

  test("mismatch branch shows the delta and balances", () => {
    const reconciliation = reconciliationFor(
      { cleared_balance: 950_000 },
      [tx({ id: "u1", cleared: "uncleared" })],
      900_000,
    );
    const out = renderReconcile({ reconciliation, locked: [] }, "USD");
    expect(out).toContain("off by -$50.00");
    expect(out).toContain("Statement balance: $900.00");
    expect(out).toContain("YNAB cleared balance: $950.00");
  });

  test("already-reconciled branch when verified+match but nothing to lock", () => {
    const reconciliation = reconciliationFor(
      { cleared_balance: 950_000 },
      [tx({ id: "u1", cleared: "uncleared" })],
      950_000,
    );
    const out = renderReconcile({ reconciliation, locked: [] }, "USD");
    expect(out).toContain("already reconciled — nothing to lock");
  });

  test("locked branch reports count and per-item lines", () => {
    const reconciliation = reconciliationFor(
      { cleared_balance: 950_000 },
      [tx({ id: "c1" })],
      950_000,
    );
    const out = renderReconcile({
      reconciliation,
      locked: [
        { ok: true, transaction_id: "c1", transaction: tx({ id: "c1", cleared: "reconciled" }) },
      ],
    }, "USD");
    expect(out).toContain("Reconciled Checking — locked 1 / 1 transaction");
    expect(out).toContain("[ok]");
  });

  test("health header reflects link status", () => {
    const reconciliation = reconciliationFor(
      {
        direct_import_linked: true,
        last_reconciled_at: "2026-04-30T00:00:00+00:00",
      },
      [],
      950_000,
    );
    const out = renderReconcile({ reconciliation, locked: [] }, "USD");
    expect(out).toContain("Account: Checking — linked ✓, last reconciled 2026-04-30");
  });
});
