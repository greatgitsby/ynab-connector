import { describe, test, expect, vi } from "vitest";
import {
  YnabError,
  type Account,
  type Transaction,
  type YnabClient,
} from "../ynab";
import {
  applyReconcile,
  computeReconcilePlan,
  renderReconcile,
} from "./reconcile-account";

const account = (over: Partial<Account>): Account => ({
  id: "acc-1",
  name: "Checking",
  type: "checking",
  on_budget: true,
  closed: false,
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
    ...over,
  }) as Transaction;

describe("computeReconcilePlan", () => {
  test("verified + matching: only cleared (non-reconciled) txns are lockable", () => {
    const plan = computeReconcilePlan(
      account({ cleared_balance: 950_000 }),
      [
        tx({ id: "c1", cleared: "cleared" }),
        tx({ id: "c2", cleared: "cleared" }),
        tx({ id: "u1", cleared: "uncleared" }),
        tx({ id: "r1", cleared: "reconciled" }),
      ],
      950_000,
    );
    expect(plan.verified).toBe(true);
    expect(plan.matches).toBe(true);
    expect(plan.delta).toBe(0);
    expect(plan.toReconcile.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(plan.uncleared.map((t) => t.id)).toEqual(["u1"]);
  });

  test("mismatch: matches=false, signed delta, uncleared listed", () => {
    const plan = computeReconcilePlan(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "u1", cleared: "uncleared" })],
      900_000,
    );
    expect(plan.matches).toBe(false);
    expect(plan.delta).toBe(-50_000); // statement - cleared
    expect(plan.uncleared.map((t) => t.id)).toEqual(["u1"]);
  });

  test("unapproved and uncategorized txns block; transfers and splits don't", () => {
    const plan = computeReconcilePlan(
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
    expect(plan.verified).toBe(false);
    expect(
      plan.unverified.map((u) => [u.tx.id, u.reason]),
    ).toEqual([
      ["unappr", "unapproved"],
      ["uncat", "uncategorized"],
    ]);
  });

  test("already-reconciled and deleted rows are ignored for verification", () => {
    const plan = computeReconcilePlan(
      account({}),
      [
        tx({ id: "r1", cleared: "reconciled", approved: false }),
        tx({ id: "d1", deleted: true, approved: false }),
      ],
      950_000,
    );
    expect(plan.verified).toBe(true);
    expect(plan.toReconcile).toHaveLength(0);
  });

  test("surfaces link-health fields from the account", () => {
    const plan = computeReconcilePlan(
      account({
        direct_import_linked: true,
        direct_import_in_error: true,
        last_reconciled_at: "2026-04-30T00:00:00+00:00",
      }),
      [],
      950_000,
    );
    expect(plan.directImportLinked).toBe(true);
    expect(plan.directImportInError).toBe(true);
    expect(plan.lastReconciledAt).toBe("2026-04-30T00:00:00+00:00");
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
      async (_budgetId: string, body: unknown) => {
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
    const plan = computeReconcilePlan(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" }), tx({ id: "c2" })],
      950_000,
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", plan);

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
    const plan = computeReconcilePlan(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" })],
      900_000, // mismatch
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", plan);

    expect(bodies).toHaveLength(0);
    expect(out.locked).toHaveLength(0);
  });

  test("unverified: no YNAB call even when the balance would match", async () => {
    const { client, bodies } = stub(() => []);
    const plan = computeReconcilePlan(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1", approved: false })], // unverified
      950_000, // would match
    );
    expect(plan.matches).toBe(true);

    const out = await applyReconcile(client as YnabClient, "bud-1", plan);

    expect(bodies).toHaveLength(0);
    expect(out.locked).toHaveLength(0);
  });

  test("nothing to lock: no YNAB call", async () => {
    const { client, bodies } = stub(() => []);
    const plan = computeReconcilePlan(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "u1", cleared: "uncleared" })],
      950_000,
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", plan);

    expect(bodies).toHaveLength(0);
    expect(out.locked).toHaveLength(0);
  });

  test("whole-batch YnabError surfaces as per-item errors", async () => {
    const { client } = stub(() => new YnabError(401, "expired"));
    const plan = computeReconcilePlan(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" }), tx({ id: "c2" })],
      950_000,
    );

    const out = await applyReconcile(client as YnabClient, "bud-1", plan);

    expect(out.locked.map((r) => r.ok)).toEqual([false, false]);
    if (!out.locked[0].ok) {
      expect(out.locked[0].error).toBe("YNAB 401: expired");
    }
  });
});

describe("renderReconcile", () => {
  const planFor = (
    acc: Partial<Account>,
    txns: Transaction[],
    statement: number,
  ) => computeReconcilePlan(account(acc), txns, statement);

  test("blocked branch lists offenders with reasons", () => {
    const plan = planFor({}, [
      tx({ id: "unappr", approved: false }),
      tx({ id: "uncat", category_id: null }),
    ], 950_000);
    const out = renderReconcile({ plan, locked: [] });
    expect(out).toContain("Cannot reconcile Checking — 2 transactions need review");
    expect(out).toContain("[unapproved]");
    expect(out).toContain("[uncategorized]");
  });

  test("mismatch branch shows the delta and balances", () => {
    const plan = planFor(
      { cleared_balance: 950_000 },
      [tx({ id: "u1", cleared: "uncleared" })],
      900_000,
    );
    const out = renderReconcile({ plan, locked: [] });
    expect(out).toContain("off by -$50.00");
    expect(out).toContain("Statement balance: $900.00");
    expect(out).toContain("YNAB cleared balance: $950.00");
  });

  test("already-reconciled branch when verified+match but nothing to lock", () => {
    const plan = planFor(
      { cleared_balance: 950_000 },
      [tx({ id: "u1", cleared: "uncleared" })],
      950_000,
    );
    const out = renderReconcile({ plan, locked: [] });
    expect(out).toContain("already reconciled — nothing to lock");
  });

  test("locked branch reports count and per-item lines", () => {
    const plan = planFor(
      { cleared_balance: 950_000 },
      [tx({ id: "c1" })],
      950_000,
    );
    const out = renderReconcile({
      plan,
      locked: [
        { ok: true, transaction_id: "c1", transaction: tx({ id: "c1", cleared: "reconciled" }) },
      ],
    });
    expect(out).toContain("Reconciled Checking — locked 1 / 1 transaction");
    expect(out).toContain("[ok]");
  });

  test("health header reflects link status", () => {
    const plan = planFor(
      {
        direct_import_linked: true,
        last_reconciled_at: "2026-04-30T00:00:00+00:00",
      },
      [],
      950_000,
    );
    const out = renderReconcile({ plan, locked: [] });
    expect(out).toContain("Account: Checking — linked ✓, last reconciled 2026-04-30");
  });
});
