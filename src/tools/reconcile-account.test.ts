import { describe, test, expect, vi } from "bun:test";
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
  ReconcileResultSchema,
  type Reconciliation,
  type ReconcileResult,
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

const tx = (over: Partial<Transaction> & { id: string }): Transaction => ({
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
});

const expectStatus = <S extends Reconciliation["status"]>(
  r: Reconciliation,
  status: S,
): Extract<Reconciliation, { status: S }> => {
  expect(r.status).toBe(status);
  if (r.status !== status) throw new Error(`expected ${status}`);
  return r as Extract<Reconciliation, { status: S }>;
};

describe("computeReconciliation", () => {
  test("ready: only cleared (non-reconciled) txns are lockable", () => {
    const r = expectStatus(
      computeReconciliation(
        account({ cleared_balance: 950_000 }),
        [
          tx({ id: "c1", cleared: "cleared" }),
          tx({ id: "c2", cleared: "cleared" }),
          tx({ id: "u1", cleared: "uncleared" }),
          tx({ id: "r1", cleared: "reconciled" }),
        ],
        950_000,
      ),
      "ready",
    );
    expect(r.to_reconcile.map((t) => t.id)).toEqual(["c1", "c2"]);
  });

  test("mismatch: signed delta, uncleared listed", () => {
    const r = expectStatus(
      computeReconciliation(
        account({ cleared_balance: 950_000 }),
        [tx({ id: "u1", cleared: "uncleared" })],
        900_000,
      ),
      "mismatch",
    );
    expect(r.delta).toBe(-50_000);
    expect(r.uncleared.map((t) => t.id)).toEqual(["u1"]);
  });

  test("blocked wins over a balance mismatch", () => {
    expectStatus(
      computeReconciliation(
        account({ cleared_balance: 950_000 }),
        [tx({ id: "c1", approved: false })],
        900_000,
      ),
      "blocked",
    );
  });

  test("tracking accounts: missing categories don't block, unapproved still does", () => {
    const tracking = account({ type: "otherAsset", on_budget: false });
    const uncat = tx({ id: "u", category_id: null, category_name: null });
    expectStatus(computeReconciliation(tracking, [uncat], 950_000), "ready");
    const r = expectStatus(
      computeReconciliation(
        tracking,
        [uncat, tx({ id: "p", category_id: null, approved: false })],
        950_000,
      ),
      "blocked",
    );
    expect(r.unverified.map((u) => [u.transaction.id, u.reason])).toEqual([
      ["p", "unapproved"],
    ]);
  });

  test("unapproved and uncategorized txns block; transfers and splits don't", () => {
    const r = expectStatus(
      computeReconciliation(
        account({}),
        [
          tx({ id: "unappr", approved: false }),
          tx({ id: "uncat", category_id: null }),
          tx({ id: "xfer", category_id: null, transfer_account_id: "acc-2" }),
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
      ),
      "blocked",
    );
    expect(r.unverified.map((u) => [u.transaction.id, u.reason])).toEqual([
      ["unappr", "unapproved"],
      ["uncat", "uncategorized"],
    ]);
  });

  test("already-reconciled and deleted rows are ignored: nothing to lock", () => {
    expectStatus(
      computeReconciliation(
        account({}),
        [
          tx({ id: "r1", cleared: "reconciled", approved: false }),
          tx({ id: "d1", deleted: true, approved: false }),
        ],
        950_000,
      ),
      "nothing_to_lock",
    );
  });

  test("surfaces link-health fields from the account", () => {
    const r = computeReconciliation(
      account({
        direct_import_linked: true,
        direct_import_in_error: true,
        last_reconciled_at: "2026-04-30T00:00:00+00:00",
      }),
      [],
      950_000,
    );
    expect(r.direct_import_linked).toBe(true);
    expect(r.direct_import_in_error).toBe(true);
    expect(r.last_reconciled_at).toBe("2026-04-30T00:00:00+00:00");
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
      },
      bodies,
    };
  };

  const lockedOf = (out: ReconcileResult) => {
    ReconcileResultSchema.parse(out);
    expect(out.status).toBe("locked");
    return out.status === "locked" ? out.locked : [];
  };

  test("ready: PATCHes only {id, cleared: reconciled} rows", async () => {
    const { client, bodies } = stub(() => [
      tx({ id: "c1", cleared: "reconciled" }),
      tx({ id: "c2", cleared: "reconciled" }),
    ]);
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" }), tx({ id: "c2" })],
      950_000,
    );

    const out = await applyReconcile(
      client as YnabClient,
      "bud-1",
      reconciliation,
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      transactions: [
        { id: "c1", cleared: "reconciled" },
        { id: "c2", cleared: "reconciled" },
      ],
    });
    expect(lockedOf(out).map((r) => r.ok)).toEqual([true, true]);
  });

  test.each([
    ["mismatch", [tx({ id: "c1" })], 900_000],
    ["blocked", [tx({ id: "c1", approved: false })], 950_000],
    ["nothing_to_lock", [tx({ id: "u1", cleared: "uncleared" })], 950_000],
  ] as const)(
    "%s: no YNAB call, result passes through",
    async (status, txns, statement) => {
      const { client, bodies } = stub(() => []);
      const reconciliation = computeReconciliation(
        account({ cleared_balance: 950_000 }),
        [...txns],
        statement,
      );
      expect(reconciliation.status).toBe(status);

      const out = await applyReconcile(
        client as YnabClient,
        "bud-1",
        reconciliation,
      );

      expect(bodies).toHaveLength(0);
      expect(out).toEqual(ReconcileResultSchema.parse(reconciliation));
    },
  );

  test("whole-batch YnabError surfaces as per-item errors", async () => {
    const { client } = stub(() => new YnabError(401, "expired"));
    const reconciliation = computeReconciliation(
      account({ cleared_balance: 950_000 }),
      [tx({ id: "c1" }), tx({ id: "c2" })],
      950_000,
    );

    const locked = lockedOf(
      await applyReconcile(client as YnabClient, "bud-1", reconciliation),
    );

    expect(locked).toEqual([
      { ok: false, transaction_id: "c1", error: "YNAB 401: expired" },
      { ok: false, transaction_id: "c2", error: "YNAB 401: expired" },
    ]);
  });
});

describe("renderReconcile", () => {
  const health = {
    account_id: "acc-1",
    account_name: "Checking",
    direct_import_linked: false,
    direct_import_in_error: false,
    last_reconciled_at: null,
    cleared_balance: 950_000,
    statement_balance: 950_000,
  };

  test("blocked lists offenders with reasons", () => {
    const out = renderReconcile(
      {
        ...health,
        status: "blocked",
        unverified: [
          { transaction: tx({ id: "unappr" }), reason: "unapproved" },
          { transaction: tx({ id: "uncat" }), reason: "uncategorized" },
        ],
      },
      "USD",
    );
    expect(out).toContain(
      "Cannot reconcile Checking — 2 transactions need review",
    );
    expect(out).toContain("[unapproved]");
    expect(out).toContain("[uncategorized]");
  });

  test("mismatch shows the delta and balances", () => {
    const out = renderReconcile(
      {
        ...health,
        statement_balance: 900_000,
        status: "mismatch",
        delta: -50_000,
        uncleared: [tx({ id: "u1", cleared: "uncleared" })],
      },
      "USD",
    );
    expect(out).toContain("off by -$50.00");
    expect(out).toContain("Statement balance: $900.00");
    expect(out).toContain("YNAB cleared balance: $950.00");
    expect(out).toContain("Uncleared transactions (1):");
  });

  test("nothing_to_lock", () => {
    const out = renderReconcile(
      { ...health, status: "nothing_to_lock" },
      "USD",
    );
    expect(out).toContain("already reconciled — nothing to lock");
  });

  test("locked reports count and per-item lines", () => {
    const out = renderReconcile(
      {
        ...health,
        status: "locked",
        locked: [
          {
            ok: true,
            transaction_id: "c1",
            transaction: tx({ id: "c1", cleared: "reconciled" }),
          },
          { ok: false, transaction_id: "c2", error: "boom" },
        ],
      },
      "USD",
    );
    expect(out).toContain(
      "Reconciled Checking — locked 1 / 2 transactions (1 error)",
    );
    expect(out).toContain("[ok]");
    expect(out).toContain("- [error] tx c2: boom");
  });

  test("health header reflects link status", () => {
    const out = renderReconcile(
      {
        ...health,
        direct_import_linked: true,
        last_reconciled_at: "2026-04-30T00:00:00+00:00",
        status: "nothing_to_lock",
      },
      "USD",
    );
    expect(out).toContain(
      "Account: Checking — linked ✓, last reconciled 2026-04-30",
    );
  });
});
