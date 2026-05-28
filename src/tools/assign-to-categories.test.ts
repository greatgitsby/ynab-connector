import { describe, test, expect, vi } from "vitest";
import { YnabError, type Category, type YnabClient } from "../ynab";
import {
  applyAssignToCategories,
  renderAssignToCategoriesResult,
  type AssignToCategoriesResult,
} from "./assign-to-categories";

// Minimal Category builder.
const cat = (over: Partial<Category> & { id: string; name: string }): Category =>
  ({
    category_group_id: "grp-1",
    hidden: false,
    budgeted: 100000,
    activity: 0,
    balance: 100000,
    ...over,
  }) as Category;

// Mock YnabClient just sufficient for the apply function — only `getCategory`
// and `updateCategoryMonth` are touched.
type MockClient = Pick<YnabClient, "getCategory" | "updateCategoryMonth">;

const stubClient = (
  responder: {
    getCategory: (id: string) => Category;
    updateCategoryMonth: (
      month: string,
      id: string,
      budgeted: number,
    ) => Category | YnabError;
  },
): { client: MockClient; calls: { method: string; args: unknown[] }[] } => {
  const calls: { method: string; args: unknown[] }[] = [];
  const getCategory = vi.fn(async (_budgetId: string, id: string) => {
    calls.push({ method: "getCategory", args: [id] });
    return { data: { category: responder.getCategory(id) } };
  });
  const updateCategoryMonth = vi.fn(
    async (
      _budgetId: string,
      month: string,
      id: string,
      body: { budgeted: number },
    ) => {
      calls.push({
        method: "updateCategoryMonth",
        args: [month, id, body.budgeted],
      });
      const r = responder.updateCategoryMonth(month, id, body.budgeted);
      if (r instanceof YnabError) throw r;
      return { data: { category: r } };
    },
  );
  return {
    client: { getCategory, updateCategoryMonth } as unknown as MockClient,
    calls,
  };
};

describe("applyAssignToCategories", () => {
  test("applies all moves in order and reports before/after per item", async () => {
    const before: Record<string, Category> = {
      "cat-a": cat({ id: "cat-a", name: "Groceries", budgeted: 400000 }),
      "cat-b": cat({ id: "cat-b", name: "Dining", budgeted: 200000 }),
    };
    const after: Record<string, Category> = {
      "cat-a": cat({
        id: "cat-a",
        name: "Groceries",
        budgeted: 450000,
        balance: 450000,
      }),
      "cat-b": cat({
        id: "cat-b",
        name: "Dining",
        budgeted: 150000,
        balance: 150000,
      }),
    };
    const { client, calls } = stubClient({
      getCategory: (id) => before[id],
      updateCategoryMonth: (_m, id) => after[id],
    });

    const out = await applyAssignToCategories(client as YnabClient, "bud-1", [
      { month: "2026-05-01", category_id: "cat-a", set_budgeted_milliunits: 450000 },
      { month: "2026-05-01", category_id: "cat-b", set_budgeted_milliunits: 150000 },
    ]);

    expect(out.results).toEqual([
      {
        ok: true,
        month: "2026-05-01",
        category_id: "cat-a",
        category_name: "Groceries",
        before_budgeted: 400000,
        after_budgeted: 450000,
        balance: 450000,
      },
      {
        ok: true,
        month: "2026-05-01",
        category_id: "cat-b",
        category_name: "Dining",
        before_budgeted: 200000,
        after_budgeted: 150000,
        balance: 150000,
      },
    ]);
    expect(calls).toEqual([
      { method: "getCategory", args: ["cat-a"] },
      { method: "updateCategoryMonth", args: ["2026-05-01", "cat-a", 450000] },
      { method: "getCategory", args: ["cat-b"] },
      { method: "updateCategoryMonth", args: ["2026-05-01", "cat-b", 150000] },
    ]);
  });

  test("a mid-batch failure does not stop subsequent moves", async () => {
    const { client } = stubClient({
      getCategory: (id) => cat({ id, name: `Cat ${id}`, budgeted: 100000 }),
      updateCategoryMonth: (_m, id, budgeted) => {
        if (id === "cat-b") return new YnabError(404, "category not found");
        return cat({ id, name: `Cat ${id}`, budgeted, balance: budgeted });
      },
    });

    const out = await applyAssignToCategories(client as YnabClient, "bud-1", [
      { month: "2026-05-01", category_id: "cat-a", set_budgeted_milliunits: 50000 },
      { month: "2026-05-01", category_id: "cat-b", set_budgeted_milliunits: 50000 },
      { month: "2026-05-01", category_id: "cat-c", set_budgeted_milliunits: 50000 },
    ]);

    expect(out.results.map((r) => r.ok)).toEqual([true, false, true]);
    const errItem = out.results[1];
    if (errItem.ok) throw new Error("expected error item");
    expect(errItem.error).toBe("YNAB 404: category not found");
  });

  test("surfaces non-YnabError messages on the per-item result", async () => {
    const { client } = stubClient({
      getCategory: () => {
        throw new Error("network broken");
      },
      updateCategoryMonth: () => cat({ id: "cat-a", name: "X", budgeted: 0 }),
    });

    const out = await applyAssignToCategories(client as YnabClient, "bud-1", [
      { month: "2026-05-01", category_id: "cat-a", set_budgeted_milliunits: 0 },
    ]);

    expect(out.results[0]).toMatchObject({
      ok: false,
      error: "network broken",
    });
  });
});

describe("renderAssignToCategoriesResult", () => {
  const sample: AssignToCategoriesResult = {
    results: [
      {
        ok: true,
        month: "2026-05-01",
        category_id: "cat-a",
        category_name: "Groceries",
        before_budgeted: 400000,
        after_budgeted: 450000,
        balance: 450000,
      },
      {
        ok: false,
        month: "2026-05-01",
        category_id: "cat-b",
        error: "YNAB 404: category not found",
      },
    ],
  };

  test("header summarizes ok/total and error count", () => {
    const rendered = renderAssignToCategoriesResult(sample);
    expect(rendered).toContain("Reassigned 1 / 2 categories (1 error)");
  });

  test("ok rows show before → after with the id suffix", () => {
    const rendered = renderAssignToCategoriesResult(sample);
    expect(rendered).toContain(
      "[ok] 2026-05-01 Groceries: $400.00 → $450.00 (balance $450.00) — id cat-a",
    );
  });

  test("error rows include the message and category id", () => {
    const rendered = renderAssignToCategoriesResult(sample);
    expect(rendered).toContain(
      "[error] 2026-05-01 cat-b: YNAB 404: category not found",
    );
  });

  test("uses '=' when before equals after (no-op set)", () => {
    const noOp: AssignToCategoriesResult = {
      results: [
        {
          ok: true,
          month: "2026-05-01",
          category_id: "cat-a",
          category_name: "Groceries",
          before_budgeted: 400000,
          after_budgeted: 400000,
          balance: 400000,
        },
      ],
    };
    expect(renderAssignToCategoriesResult(noOp)).toContain("$400.00 = $400.00");
  });
});
