import { describe, test, expect, vi } from "vitest";
import { YnabError, type Transaction, type YnabClient } from "../ynab";
import {
  applyUpdateTransactions,
  buildBulkRow,
  interpretBulkResponse,
  renderUpdateTransactionsResult,
  resolveCategoryNames,
  touchedBalances,
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

  test("forwards approved: false (un-approve)", () => {
    expect(
      buildBulkRow({
        transaction_id: "tx-1",
        approved: false,
      }),
    ).toEqual({ id: "tx-1", approved: false });
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

  test("flags a split YNAB returns unsplit, or a category it ignored on a split", () => {
    const subs = [{ amount_milliunits: -10000, category_id: "cat-a" }];
    const out = interpretBulkResponse(
      [
        { transaction_id: "tx-1", subtransactions: subs },
        { transaction_id: "tx-2", subtransactions: subs },
        // YNAB answers 200 and keeps the split; see the error below.
        { transaction_id: "tx-2", category_id: "cat-b", memo: "m" },
        { transaction_id: "tx-1", category_id: "cat-b" },
      ],
      [
        tx({ id: "tx-1" }),
        tx({
          id: "tx-2",
          subtransactions: [
            {
              id: "s1",
              transaction_id: "tx-2",
              amount: -10000,
              memo: null,
              payee_id: null,
              payee_name: null,
              category_id: "cat-a",
              category_name: "A",
              transfer_account_id: null,
              transfer_transaction_id: null,
              deleted: false,
            },
          ],
        }),
      ],
    );
    expect(out.results.map((r) => r.ok)).toEqual([false, true, false, true]);
    if (!out.results[0].ok) {
      expect(out.results[0].error).toMatch(/did not come back split/);
    }
    if (!out.results[2].ok) {
      expect(out.results[2].error).toMatch(/ignored the category change/);
    }
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
  const sub = {
    id: "s1",
    transaction_id: "tx-split",
    amount: -10000,
    memo: null,
    payee_id: null,
    payee_name: null,
    category_id: "cat-a",
    category_name: "A",
    deleted: false,
  };

  const stub = (
    responder: (body: unknown) => Transaction[] | YnabError,
    existing: Transaction[] = [],
  ): {
    client: Pick<YnabClient, "updateTransactionsBulk" | "getTransaction">;
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
    const getTransaction = vi.fn(async (_planId: string, id: string) => {
      const t = existing.find((e) => e.id === id);
      if (!t) throw new YnabError(404, "not found");
      return { data: { transaction: t } };
    });
    return {
      client: { updateTransactionsBulk, getTransaction },
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

  test("refuses a resplit, a sum mismatch, or a failed lookup, sends the rest", async () => {
    const charge = { amount: -24010, import_id: "YNAB:-24010:2026-11-09:1" };
    const { client, bodies } = stub(
      () => [
        tx({ id: "tx-plain", ...charge, subtransactions: [sub] }),
        tx({ id: "tx-split", memo: "m" }),
      ],
      [
        tx({ id: "tx-split", subtransactions: [sub] }),
        tx({ id: "tx-plain", ...charge }),
        tx({ id: "tx-short", ...charge }),
      ],
    );
    const split = [
      { amount_milliunits: -14190, category_id: "cat-spotify", memo: "Spotify" },
      { amount_milliunits: -9820, category_id: "cat-netflix", memo: "Netflix" },
    ];
    const short = [
      { amount_milliunits: -14190, category_id: "cat-spotify" },
      { amount_milliunits: -9810, category_id: "cat-netflix" },
    ];

    const out = await applyUpdateTransactions(client as YnabClient, "bud-1", [
      { transaction_id: "tx-split", subtransactions: split },
      { transaction_id: "tx-plain", subtransactions: split },
      { transaction_id: "tx-split", memo: "m" },
      { transaction_id: "tx-gone", subtransactions: split },
      { transaction_id: "tx-short", subtransactions: short },
    ]);

    // The split row carries only the parts: no amount, date, cleared,
    // approved, or import_id, so YNAB keeps those and the import match.
    expect(bodies).toEqual([
      {
        transactions: [
          {
            id: "tx-plain",
            subtransactions: [
              { amount: -14190, category_id: "cat-spotify", memo: "Spotify" },
              { amount: -9820, category_id: "cat-netflix", memo: "Netflix" },
            ],
          },
          { id: "tx-split", memo: "m" },
        ],
      },
    ]);
    expect(out.results.map((r) => [r.transaction_id, r.ok])).toEqual([
      ["tx-split", false],
      ["tx-plain", true],
      ["tx-split", true],
      ["tx-gone", false],
      ["tx-short", false],
    ]);
    if (!out.results[0].ok) {
      expect(out.results[0].error).toMatch(/already a split/i);
    }
    if (!out.results[3].ok) {
      expect(out.results[3].error).toBe("YNAB 404: not found");
    }
    if (!out.results[4].ok) {
      expect(out.results[4].error).toMatch(
        /sum to -24000 milliunits but the transaction is -24010 \(off by -10\)/,
      );
    }
  });

  test("skips the PATCH when every input is a locked split", async () => {
    const { client, bodies } = stub(
      () => [],
      [
        tx({
          id: "tx-split",
          subtransactions: [sub],
        }),
      ],
    );

    const out = await applyUpdateTransactions(client as YnabClient, "bud-1", [
      {
        transaction_id: "tx-split",
        subtransactions: [{ amount_milliunits: -10000 }],
      },
    ]);

    expect(bodies).toHaveLength(0);
    expect(out.results.map((r) => r.ok)).toEqual([false]);
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
    const rendered = renderUpdateTransactionsResult(sample, "USD");
    expect(rendered).toContain("Updated 1 / 2 transactions (1 error)");
  });

  test("ok rows render payee → category, approval, cleared", () => {
    const rendered = renderUpdateTransactionsResult(sample, "USD");
    expect(rendered).toContain(
      "[ok] 2026-05-15 -$45.00 Starbucks → Coffee, approved, cleared — id tx-1",
    );
  });

  test("split transactions show an N-way split note and their parts", () => {
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
    const rendered = renderUpdateTransactionsResult(splitSample, "USD");
    expect(rendered).toContain("(2-way split)");
    expect(rendered).toContain("\n  - -$2.50 → A\n  - -$2.00 → B");
  });
});

describe("resolveCategoryNames", () => {
  const groups = [
    {
      id: "g1",
      name: "Subs",
      hidden: false,
      internal: false,
      deleted: false,
      categories: [
        { id: "c-net", name: "🎥 Netflix", category_group_id: "g1", hidden: false, internal: false, deleted: false, budgeted: 0, activity: 0, balance: 0 },
        { id: "c-tv1", name: "TV", category_group_id: "g1", hidden: false, internal: false, deleted: false, budgeted: 0, activity: 0, balance: 0 },
        { id: "c-tv2", name: "TV", category_group_id: "g1", hidden: false, internal: false, deleted: false, budgeted: 0, activity: 0, balance: 0 },
      ],
    },
  ];

  test("names become ids on the row and its parts; a bad name fails only its row", () => {
    const { inputs, failed } = resolveCategoryNames(
      [
        { transaction_id: "t1", category_name: "netflix", approved: true },
        { transaction_id: "t2", subtransactions: [{ amount_milliunits: -1, category_name: "Netflix" }, { amount_milliunits: -2, category_id: "c-x" }] },
        { transaction_id: "t3", category_name: "TV" },
      ],
      groups,
    );
    expect(inputs[0]).toEqual({ transaction_id: "t1", category_id: "c-net", approved: true });
    expect(buildBulkRow(inputs[1]).subtransactions).toEqual([
      { amount: -1, category_id: "c-net" },
      { amount: -2, category_id: "c-x" },
    ]);
    expect([...failed.keys()]).toEqual([inputs[2]]);
    expect(failed.get(inputs[2])).toContain("matches 2 categories");
  });
});

describe("touchedBalances", () => {
  test("reports the categories updated transactions and their parts now use", () => {
    const month = {
      month: "2026-11-01", income: 0, budgeted: 0, activity: 0, to_be_budgeted: 0, age_of_money: null, deleted: false,
      categories: ["a", "b", "c"].map((id) => ({ id, name: id, category_group_id: "g", hidden: false, internal: false, deleted: false, budgeted: 1, activity: 2, balance: 3 })),
    };
    const t = (id: string, category_id: string | null, subs: string[] = []) =>
      ({ id, category_id, subtransactions: subs.map((c) => ({ id: `${id}-${c}`, category_id: c, deleted: false })) }) as unknown as Transaction;
    const out = touchedBalances(
      [
        { ok: true, transaction_id: "t1", transaction: t("t1", "a") },
        { ok: true, transaction_id: "t2", transaction: t("t2", null, ["c"]) },
        { ok: false, transaction_id: "t3", error: "x" },
      ],
      month,
    );
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
    expect(out[0]).toEqual({ id: "a", name: "a", budgeted: 1, activity: 2, balance: 3 });
  });
});
