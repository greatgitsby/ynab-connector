import { describe, test, expect } from "vitest";
import type { ScheduledTransaction } from "../ynab";
import {
  computeScheduledTransactionList,
  renderScheduledTransactionList,
  ScheduledTransactionListSchema,
} from "./list-scheduled-transactions";

const st = (
  id: string,
  overrides: Partial<ScheduledTransaction> = {},
): ScheduledTransaction => ({
  id,
  date_first: "2026-01-01",
  date_next: "2026-11-01",
  frequency: "monthly",
  amount: -1_500_000,
  account_id: "acc-1",
  account_name: "Checking",
  payee_name: "Landlord",
  category_name: "Rent",
  deleted: false,
  subtransactions: [],
  ...overrides,
});

const fetched = [
  st("rent", { date_next: "2026-12-01" }),
  st("gym", { date_next: "2026-11-05", amount: -40_000, payee_name: "Gym" }),
  st("gone", { deleted: true }),
  st("loan", {
    date_next: "2027-02-01",
    frequency: "never",
    transfer_account_id: "acc-2",
    category_name: null,
  }),
];

describe("computeScheduledTransactionList", () => {
  test("drops deleted rows, sorts soonest first, and stops at until_date", () => {
    const all = computeScheduledTransactionList(fetched, { iso: "USD" });
    expect(all.scheduled_transactions.map((s) => s.id)).toEqual([
      "gym",
      "rent",
      "loan",
    ]);
    expect(() => ScheduledTransactionListSchema.parse(all)).not.toThrow();
    const soon = computeScheduledTransactionList(fetched, {
      untilDate: "2026-12-01",
      iso: "USD",
    });
    expect(soon.scheduled_transactions.map((s) => s.id)).toEqual(["gym", "rent"]);
  });

  test("renders one-off transfers as such", () => {
    const out = renderScheduledTransactionList(
      computeScheduledTransactionList(fetched, { iso: "USD" }),
      { includeIds: false },
    );
    expect(out).toContain("- 2026-11-05 -$40.00 Gym → Rent [Checking], monthly");
    expect(out).toContain("(transfer) [Checking], once");
  });
});
