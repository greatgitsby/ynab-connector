import { describe, test, expect } from "vitest";
import type {
  Category,
  CategoryGroup,
  MonthDetail,
  Transaction,
} from "../ynab";
import {
  computeCategoryDetails,
  renderCategoryDetails,
  CategoryDetailsSchema,
} from "./get-category-details";

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
  amount: 0,
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

const monthDetail = (categories: Category[]): MonthDetail => ({
  month: "2026-05-01",
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 0,
  age_of_money: null,
  categories,
});

const groups: CategoryGroup[] = [
  {
    id: "grp-bills",
    name: "Monthly Bills",
    hidden: false,
    categories: [
      cat({ id: "groceries", name: "Groceries", category_group_id: "grp-bills" }),
    ],
  },
];

describe("computeCategoryDetails", () => {
  test("returns null when the category is missing from the month", () => {
    const r = computeCategoryDetails(monthDetail([]), groups, [], {
      categoryId: "missing",
    });
    expect(r).toBeNull();
  });

  test("resolves group name from category_groups", () => {
    const r = computeCategoryDetails(
      monthDetail([cat({ id: "groceries", name: "Groceries" })]),
      groups,
      [],
      { categoryId: "groceries" },
    );
    expect(r?.groupName).toBe("Monthly Bills");
  });

  test("expands subtransactions matching the category", () => {
    const txs: Transaction[] = [
      tx({
        id: "parent-1",
        date: "2026-05-10",
        payee_name: "Costco",
        category_id: null,
        amount: -100_000,
        subtransactions: [
          {
            id: "sub-a",
            transaction_id: "parent-1",
            amount: -40_000,
            memo: null,
            payee_id: null,
            payee_name: null,
            category_id: "groceries",
            category_name: "Groceries",
          },
          {
            id: "sub-b",
            transaction_id: "parent-1",
            amount: -60_000,
            memo: null,
            payee_id: null,
            payee_name: null,
            category_id: "other",
            category_name: "Other",
          },
        ],
      }),
    ];
    const r = computeCategoryDetails(
      monthDetail([cat({ id: "groceries", name: "Groceries" })]),
      groups,
      txs,
      { categoryId: "groceries" },
    );
    expect(r?.activity).toHaveLength(1);
    expect(r?.activity[0].sub_id).toBe("sub-a");
    expect(r?.activity[0].note).toBe('split from "Costco"');
  });

  test("includes parent transactions with matching category_id", () => {
    const txs: Transaction[] = [
      tx({
        id: "t1",
        date: "2026-05-08",
        payee_name: "Wholesome",
        category_id: "groceries",
        amount: -25_000,
      }),
    ];
    const r = computeCategoryDetails(
      monthDetail([cat({ id: "groceries", name: "Groceries" })]),
      groups,
      txs,
      { categoryId: "groceries" },
    );
    expect(r?.activity).toHaveLength(1);
    expect(r?.activity[0].sub_id).toBeUndefined();
    expect(r?.sum).toBe(-25_000);
  });

  test("sorts activity by date desc", () => {
    const txs: Transaction[] = [
      tx({ id: "old", date: "2026-05-01", category_id: "groceries", amount: -10_000 }),
      tx({ id: "new", date: "2026-05-25", category_id: "groceries", amount: -20_000 }),
    ];
    const r = computeCategoryDetails(
      monthDetail([cat({ id: "groceries", name: "Groceries" })]),
      groups,
      txs,
      { categoryId: "groceries" },
    );
    expect(r?.activity.map((a) => a.parent_id)).toEqual(["new", "old"]);
  });

  test("result conforms to CategoryDetailsSchema", () => {
    const txs: Transaction[] = [
      tx({ id: "t1", date: "2026-05-08", category_id: "groceries", amount: -25_000 }),
    ];
    const r = computeCategoryDetails(
      monthDetail([cat({ id: "groceries", name: "Groceries" })]),
      groups,
      txs,
      { categoryId: "groceries" },
    );
    expect(() => CategoryDetailsSchema.parse(r)).not.toThrow();
  });
});

describe("renderCategoryDetails", () => {
  test("renders group, category, monthly summary, and one line per tx", () => {
    const txs: Transaction[] = [
      tx({ id: "t1", date: "2026-05-08", category_id: "groceries", amount: -25_000 }),
    ];
    const details = computeCategoryDetails(
      monthDetail([
        cat({
          id: "groceries",
          name: "Groceries",
          budgeted: 500_000,
          activity: -25_000,
          balance: 475_000,
        }),
      ]),
      groups,
      txs,
      { categoryId: "groceries" },
    );
    const out = renderCategoryDetails(details!, { includeIds: false });
    expect(out).toContain("Monthly Bills → Groceries");
    expect(out).toContain("Month: 2026-05-01");
    expect(out).toContain("Budgeted: $500.00");
    expect(out).toContain("activity -$25.00");
    expect(out).toContain("Transactions this month (1");
    expect(out).toContain("Costco");
  });

  test("(none) when there is no activity", () => {
    const details = computeCategoryDetails(
      monthDetail([cat({ id: "groceries", name: "Groceries" })]),
      groups,
      [],
      { categoryId: "groceries" },
    );
    expect(renderCategoryDetails(details!, { includeIds: false })).toContain(
      "(none)",
    );
  });
});
