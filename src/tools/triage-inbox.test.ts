import { describe, test, expect } from "vitest";
import type { Category, MonthDetail, Transaction } from "../ynab";
import { computeTriageInbox, renderTriageInbox } from "./triage-inbox";

const cat = (overrides: Partial<Category>): Category => ({
  id: "cat-x",
  category_group_id: "grp-x",
  name: "Generic",
  hidden: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: "t-x",
  date: "2026-05-01",
  amount: -10_000,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "acc-1",
  account_name: "Checking",
  payee_id: null,
  payee_name: "Costco",
  category_id: null,
  category_name: null,
  flag_color: null,
  transfer_account_id: null,
  ...overrides,
});

const monthDetail = (overrides: Partial<MonthDetail> = {}): MonthDetail => ({
  month: "2026-05-01",
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 1_500_000,
  age_of_money: null,
  categories: [],
  ...overrides,
});

describe("computeTriageInbox", () => {
  test("sorts uncategorized txs desc by date and filters approved transfers out", () => {
    const uncatTxs = [
      tx({ id: "a", date: "2026-05-01" }),
      tx({ id: "b", date: "2026-05-10" }),
      tx({ id: "c", date: "2026-05-05" }),
      tx({
        id: "transfer-approved",
        date: "2026-05-12",
        transfer_account_id: "acc-2",
        approved: true,
      }),
    ];
    const r = computeTriageInbox(uncatTxs, [], monthDetail());
    expect(r.uncategorized.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  test("keeps unapproved transfers in uncategorized", () => {
    const uncatTxs = [
      tx({
        id: "transfer-pending",
        date: "2026-05-12",
        transfer_account_id: "acc-2",
        approved: false,
      }),
    ];
    const r = computeTriageInbox(uncatTxs, [], monthDetail());
    expect(r.uncategorized).toHaveLength(1);
  });

  test("dedupes autoCategorized against uncategorized by tx id", () => {
    const shared = tx({ id: "shared", date: "2026-05-10", approved: false });
    const r = computeTriageInbox(
      [shared],
      [shared, tx({ id: "auto-only", date: "2026-05-05", approved: false })],
      monthDetail(),
    );
    expect(r.uncategorized.map((t) => t.id)).toEqual(["shared"]);
    expect(r.autoCategorized.map((t) => t.id)).toEqual(["auto-only"]);
  });

  test("overspent sorts by balance asc (most overspent first), excludes internal/hidden", () => {
    const md = monthDetail({
      categories: [
        cat({ id: "ok", balance: 100_000 }),
        cat({ id: "small", balance: -5_000 }),
        cat({ id: "deep", balance: -200_000 }),
        cat({ id: "hidden-bad", balance: -300_000, hidden: true }),
        cat({
          id: "internal-bad",
          balance: -400_000,
          internal: true,
          name: "Uncategorized",
        }),
      ],
    });
    const r = computeTriageInbox([], [], md);
    expect(r.overspent.map((c) => c.id)).toEqual(["deep", "small"]);
  });

  test("underfunded sorts by underfunded desc and exposes interpreted goal info", () => {
    const md = monthDetail({
      categories: [
        cat({
          id: "small-gap",
          goal_under_funded: 25_000,
          goal_target: 100_000,
          goal_type: "MF",
        }),
        cat({
          id: "big-gap",
          goal_under_funded: 300_000,
          goal_target: 500_000,
          goal_type: "MF",
        }),
        cat({ id: "no-goal" }),
      ],
    });
    const r = computeTriageInbox([], [], md);
    expect(r.underfunded.map((u) => u.id)).toEqual(["big-gap", "small-gap"]);
    expect(r.underfunded[0].cadenceLabel).toBe("/month");
    expect(r.underfunded[0].goalTarget).toBe(500_000);
    expect(r.underfunded[0].underfunded).toBe(300_000);
  });

  test("readyToAssign reads from month.to_be_budgeted", () => {
    const r = computeTriageInbox([], [], monthDetail({ to_be_budgeted: 999 }));
    expect(r.readyToAssign).toBe(999);
  });
});

describe("renderTriageInbox", () => {
  const inbox = () =>
    computeTriageInbox(
      [tx({ id: "u-1", payee_name: "Mystery", date: "2026-05-10" })],
      [tx({ id: "a-1", payee_name: "Auto", date: "2026-05-08", approved: false })],
      monthDetail({
        categories: [
          cat({ id: "o-1", name: "Bills", balance: -100_000 }),
          cat({
            id: "u-2",
            name: "Savings",
            goal_under_funded: 50_000,
            goal_target: 200_000,
            goal_type: "MF",
          }),
        ],
      }),
    );

  test("renders four section headers", () => {
    const out = renderTriageInbox(inbox(), {
      maxPerSection: 25,
      includeIds: false,
    });
    expect(out).toContain("Uncategorized transactions");
    expect(out).toContain("Auto-categorized");
    expect(out).toContain("Overspent categories");
    expect(out).toContain("Underfunded goals");
  });

  test("includes Ready to assign with formatted milliunits", () => {
    const out = renderTriageInbox(inbox(), {
      maxPerSection: 25,
      includeIds: false,
    });
    expect(out).toContain("Ready to assign: $1,500.00");
  });

  test("underfunded row includes /month cadence and the gap", () => {
    const out = renderTriageInbox(inbox(), {
      maxPerSection: 25,
      includeIds: false,
    });
    expect(out).toContain("needs $50.00 more this month");
    expect(out).toContain("$200.00/month");
  });
});
