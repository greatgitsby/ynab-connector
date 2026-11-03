import { describe, test, expect, vi } from "vitest";
import {
  YnabError,
  type Payee,
  type ScheduledTransaction,
  type SubTransaction,
  type Transaction,
  type YnabClient,
} from "../ynab";
import {
  applyMerge,
  MergePayeesResultSchema,
  planMerge,
  renderMerge,
  scheduledBody,
  type MergePayeesResult,
} from "./merge-payees";

const p = (id: string, name: string, over: Partial<Payee> = {}): Payee => ({
  id,
  name,
  transfer_account_id: null,
  deleted: false,
  ...over,
});

const tx = (id: string, payee_id: string | null, subs: Partial<SubTransaction>[] = [], over: Partial<Transaction> = {}) =>
  ({
    id,
    date: "2026-05-01",
    amount: -1000,
    payee_id,
    deleted: false,
    subtransactions: subs.map((s, i) => ({ id: `${id}-${i}`, transaction_id: id, amount: -500, deleted: false, ...s })),
    ...over,
  }) as Transaction;

const st = (id: string, payee_id: string | null, subs: Partial<SubTransaction>[] = []) =>
  ({
    id,
    date_first: "2026-01-01",
    date_next: "2026-12-01",
    frequency: "monthly",
    amount: -4000,
    memo: "membership",
    flag_color: "red",
    account_id: "acc-1",
    account_name: "Checking",
    payee_id,
    category_id: "cat-1",
    transfer_account_id: null,
    deleted: false,
    subtransactions: subs.map((s) => ({ deleted: false, ...s })),
  }) as ScheduledTransaction;

const payees = [
  p("keep", "Starbucks"),
  p("dup1", "STARBUCKS #123"),
  p("dup2", "Starbucks Westshore"),
  p("other", "Gym"),
  p("xfer", "Transfer : Savings", { transfer_account_id: "acc-2" }),
  p("gone", "Old", { deleted: true }),
];

const transactions = [
  tx("t1", "dup1", [], { date: "2026-01-02", amount: -2000 }),
  tx("t2", "dup1", [], { date: "2026-03-04", amount: -3000 }),
  // Split parent on dup2 moves; its part on dup1 can't.
  tx("t3", "dup2", [{ payee_id: "dup1", amount: -700 }, { payee_id: null }]),
  tx("t4", "other"),
  tx("t5", "dup1", [], { deleted: true }),
];

const scheduled = [
  st("s1", "dup1"),
  st("s2", "dup2", [{ id: "s2-a", payee_id: null, amount: -2000 }, { id: "s2-b", payee_id: "dup1", amount: -2000 }]),
  st("s3", "other"),
];

const plan = () => {
  const r = planMerge(payees, transactions, scheduled, "keep", ["dup1", "dup2", "dup1"], "USD");
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("planMerge", () => {
  test("collects movable transactions and schedules per source, and what must stay", () => {
    const r = plan();
    expect(r.applied).toBe(false);
    expect(r.target).toEqual({ id: "keep", name: "Starbucks" });
    const [dup1, dup2] = r.sources;
    expect(dup1.transactions.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(dup1.scheduled.map((t) => t.id)).toEqual(["s1"]);
    expect(dup1.left).toEqual([
      { kind: "split_part", id: "t3", date: "2026-05-01", amount: -700 },
      { kind: "scheduled_split_part", id: "s2", date: "2026-12-01", amount: -2000 },
    ]);
    expect(dup2.transactions.map((t) => t.id)).toEqual(["t3"]);
    expect(dup2.scheduled).toEqual([]);
    expect(dup2.left).toEqual([{ kind: "scheduled_split", id: "s2", date: "2026-12-01", amount: -4000 }]);
    expect(() => MergePayeesResultSchema.parse(r)).not.toThrow();
  });

  test("refuses bad targets and sources", () => {
    const err = (target: string, sources: string[]) => {
      const r = planMerge(payees, transactions, scheduled, target, sources, "USD");
      return "error" in r ? r.error : null;
    };
    expect(err("gone", ["dup1"])).toMatch(/No payee/);
    expect(err("xfer", ["dup1"])).toMatch(/transfer/);
    expect(err("keep", ["keep"])).toMatch(/is the target/);
    expect(err("keep", ["nope"])).toMatch(/No payee/);
    expect(err("keep", ["xfer"])).toMatch(/transfer/);
  });
});

describe("scheduledBody", () => {
  test("carries every field over, since PUT replaces the whole scheduled transaction", () => {
    expect(scheduledBody(scheduled[0], "keep")).toEqual({
      account_id: "acc-1",
      date: "2026-12-01",
      amount: -4000,
      payee_id: "keep",
      category_id: "cat-1",
      memo: "membership",
      flag_color: "red",
      frequency: "monthly",
    });
  });
});

describe("applyMerge", () => {
  test("bulk-patches payee_id only, PUTs schedules, and reports what YNAB rejected", async () => {
    const updateTransactionsBulk = vi.fn(async (_plan: string, body: { transactions: { id: string }[] }) => ({
      // t2 is missing from YNAB's response.
      data: { transactions: body.transactions.filter((t) => t.id !== "t2"), transaction_ids: [] },
    }));
    const updateScheduledTransaction = vi.fn(async () => {
      throw new YnabError(400, "date must be in the future");
    });
    const client = { updateTransactionsBulk, updateScheduledTransaction } as unknown as YnabClient;

    const out = await applyMerge(client, "plan", plan(), scheduled);

    expect(updateTransactionsBulk).toHaveBeenCalledWith("plan", {
      transactions: [
        { id: "t1", payee_id: "keep" },
        { id: "t2", payee_id: "keep" },
        { id: "t3", payee_id: "keep" },
      ],
    });
    expect(updateScheduledTransaction).toHaveBeenCalledWith("plan", "s1", expect.objectContaining({ payee_id: "keep" }));
    expect(out.applied).toBe(true);
    const [dup1, dup2] = out.sources;
    expect(dup1.transactions.map((t) => t.id)).toEqual(["t1"]);
    expect(dup1.scheduled).toEqual([]);
    expect(dup1.failed).toEqual([
      { kind: "transaction", id: "t2", error: "Not in YNAB's bulk-update response." },
      { kind: "scheduled", id: "s1", error: "YNAB 400: date must be in the future" },
    ]);
    expect(dup2.transactions.map((t) => t.id)).toEqual(["t3"]);
  });

  test("a failed bulk call fails every row in it", async () => {
    const client = {
      updateTransactionsBulk: async () => {
        throw new YnabError(500, "down");
      },
      updateScheduledTransaction: async () => ({}),
    } as unknown as YnabClient;
    const out = await applyMerge(client, "plan", plan(), scheduled);
    expect(out.sources.flatMap((s) => s.transactions)).toEqual([]);
    expect(out.sources.flatMap((s) => s.failed.map((f) => f.id))).toEqual(["t1", "t2", "t3"]);
  });
});

describe("renderMerge", () => {
  test("a preview says nothing changed and how to apply", () => {
    const text = renderMerge(plan());
    expect(text).toContain('Preview: merge 2 payees into "Starbucks" (nothing changed yet)');
    expect(text).toContain("would move 2 transactions, 2026-01-02 to 2026-03-04, total -$5.00; 1 scheduled transaction");
    expect(text).toContain("apply: true");
    expect(text).toMatch(/stays: 2026-05-01 -\$0\.70 split part/);
  });

  test("an applied merge does not ask to apply again", () => {
    const applied: MergePayeesResult = { ...plan(), applied: true };
    const text = renderMerge(applied);
    expect(text).toContain('Merged 2 payees into "Starbucks"');
    expect(text).not.toContain("apply: true");
  });
});
