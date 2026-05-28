import { describe, test, expect, vi } from "vitest";
import { YnabError, type Transaction, type YnabClient } from "../ynab";
import {
  applyUpdateTransactions,
  buildBulkRow,
  interpretBulkResponse,
  renderUpdateTransactionsResult,
  type UpdateTransactionsResult,
} from "./update-transactions";

const tx = (
  over: Partial<Transaction> & { id: string },
): Transaction =>
  ({
    date: "2026-05-15",
    amount: -10000,
    memo: null,
    cleared: "cleared",
    approved: true,
    account_id: "acc-1",
    account_name: "Checking",
    payee_id: null,
    payee_name: null,
    category_id: null,
    category_name: null,
    flag_color: null,
    transfer_account_id: null,
    ...over,
  }) as Transaction;

describe("buildBulkRow", () => {
  test("includes only the fields the caller set", () => {
    expect(
      buildBulkRow({
        transaction_id: "tx-1",
        approved: true,
      }),
    ).toEqual({ id: "tx-1", approved: true });
  });

  test("preserves explicit nulls (e.g., clearing a category)", () => {
    expect(
      buildBulkRow({
        transaction_id: "tx-1",
        category_id: null,
        memo: null,
      }),
    ).toEqual({ id: "tx-1", category_id: null, memo: null });
  });

  test("translates `amount_milliunits` to `amount` on subtransactions", () => {
    const row = buildBulkRow({
      transaction_id: "tx-1",
      subtransactions: [
        { amount_milliunits: -3000, category_id: "cat-a" },
        { amount_milliunits: -2000, category_id: "cat-b", memo: "tax" },
      ],
    });
    expect(row.subtransactions).toEqual([
      { amount: -3000, category_id: "cat-a" },
      { amount: -2000, category_id: "cat-b", memo: "tax" },
    ]);
    // No `amount_milliunits` key on the wire.
    expect(row.subtransactions?.[0]).not.toHaveProperty("amount_milliunits");
  });
});

describe("interpretBulkResponse", () => {
  test("matches updated transactions to inputs by id", () => {
    const inputs = [
      { transaction_id: "tx-1", approved: true },
      { transaction_id: "tx-2", approved: true },
    ];
    const updated = [
      tx({ id: "tx-1", approved: true }),
      tx({ id: "tx-2", approved: true }),
    ];
    const out = interpretBulkResponse(inputs, updated);
    expect(out.results.map((r) => r.ok)).toEqual([true, true]);
  });

  test("flags inputs whose id is missing from the response as errors", () => {
    const inputs = [
      { transaction_id: "tx-1", approved: true },
      { transaction_id: "tx-bogus", approved: true },
    ];
    const updated = [tx({ id: "tx-1", approved: true })];
    const out = interpretBulkResponse(inputs, updated);
    expect(out.results[0].ok).toBe(true);
    expect(out.results[1].ok).toBe(false);
    if (!out.results[1].ok) {
      expect(out.results[1].error).toMatch(/not present/i);
    }
  });
});

describe("applyUpdateTransactions", () => {
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
      client: { updateTransactionsBulk } as Pick<YnabClient, "updateTransactionsBulk">,
      bodies,
    };
  };

  test("sends one bulk PATCH carrying every input as a row", async () => {
    const { client, bodies } = stub(() => [
      tx({ id: "tx-1", approved: true }),
      tx({ id: "tx-2", category_id: "cat-x", category_name: "Groceries" }),
    ]);

    await applyUpdateTransactions(client as YnabClient, "bud-1", [
      { transaction_id: "tx-1", approved: true },
      { transaction_id: "tx-2", category_id: "cat-x" },
    ]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      transactions: [
        { id: "tx-1", approved: true },
        { id: "tx-2", category_id: "cat-x" },
      ],
    });
  });

  test("whole-batch YnabError surfaces as per-item errors", async () => {
    const { client } = stub(() => new YnabError(401, "expired"));

    const out = await applyUpdateTransactions(client as YnabClient, "bud-1", [
      { transaction_id: "tx-1", approved: true },
      { transaction_id: "tx-2", approved: true },
    ]);

    expect(out.results.map((r) => r.ok)).toEqual([false, false]);
    if (!out.results[0].ok) {
      expect(out.results[0].error).toBe("YNAB 401: expired");
    }
  });
});

describe("renderUpdateTransactionsResult", () => {
  const sample: UpdateTransactionsResult = {
    results: [
      {
        ok: true,
        transaction_id: "tx-1",
        transaction: {
          id: "tx-1",
          date: "2026-05-15",
          amount: -45000,
          memo: null,
          cleared: "cleared",
          approved: true,
          account_id: "acc-1",
          account_name: "Checking",
          payee_id: null,
          payee_name: "Starbucks",
          category_id: "cat-coffee",
          category_name: "Coffee",
          flag_color: null,
          transfer_account_id: null,
        } as Transaction,
      },
      {
        ok: false,
        transaction_id: "tx-bogus",
        error: "Not present in YNAB's bulk-update response.",
      },
    ],
  };

  test("header shows ok/total and error count", () => {
    const rendered = renderUpdateTransactionsResult(sample);
    expect(rendered).toContain("Updated 1 / 2 transactions (1 error)");
  });

  test("ok rows render payee → category, approval, cleared", () => {
    const rendered = renderUpdateTransactionsResult(sample);
    expect(rendered).toContain(
      "[ok] 2026-05-15 -$45.00 Starbucks → Coffee, approved, cleared — id tx-1",
    );
  });

  test("split transactions show an N-way split note", () => {
    const splitSample: UpdateTransactionsResult = {
      results: [
        {
          ok: true,
          transaction_id: "tx-split",
          transaction: {
            ...(sample.results[0] as { transaction: Transaction }).transaction,
            id: "tx-split",
            category_name: null,
            subtransactions: [
              {
                id: "s1",
                transaction_id: "tx-split",
                amount: -2500,
                memo: null,
                payee_id: null,
                payee_name: null,
                category_id: "cat-a",
                category_name: "A",
              },
              {
                id: "s2",
                transaction_id: "tx-split",
                amount: -2000,
                memo: null,
                payee_id: null,
                payee_name: null,
                category_id: "cat-b",
                category_name: "B",
              },
            ],
          } as Transaction,
        },
      ],
    };
    expect(renderUpdateTransactionsResult(splitSample)).toContain(
      "(2-way split)",
    );
  });
});
