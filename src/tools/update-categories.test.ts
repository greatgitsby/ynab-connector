import { describe, test, expect, vi } from "vitest";
import { YnabError, type YnabClient } from "../ynab";
import { groups } from "./categories.fixture";
import {
  UpdateCategoriesResultSchema,
  changeBody,
  renderUpdateCategories,
  updateCategories,
} from "./update-categories";

describe("changeBody", () => {
  test("sends only what changes", () => {
    expect(changeBody({ category_id: "games", name: "Gaming" }, groups())).toEqual({ body: { name: "Gaming" } });
    expect(changeBody({ category_id: "games", category_group_id: "subs" }, groups())).toEqual({
      body: { category_group_id: "subs" },
    });
    expect(changeBody({ category_id: "games", name: "Games", category_group_id: "subs" }, groups())).toEqual({
      body: { category_group_id: "subs" },
    });
  });

  test("refuses what YNAB would reject or what would confuse later", () => {
    const refuse = (c: Parameters<typeof changeBody>[0]) => (changeBody(c, groups()) as { error: string }).error;
    expect(refuse({ category_id: "nope", name: "x" })).toMatch(/No such category/);
    expect(refuse({ category_id: "gone", name: "x" })).toMatch(/No such category/);
    expect(refuse({ category_id: "rta", name: "x" })).toMatch(/managed by YNAB/);
    expect(refuse({ category_id: "visa", category_group_id: "fun" })).toMatch(/managed by YNAB/);
    expect(refuse({ category_id: "games", name: "netflix " })).toMatch(/"Netflix" \(id netflix, in Monthly Subscriptions\)/);
    expect(refuse({ category_id: "games", name: "old" })).toMatch(/hidden/);
    expect(refuse({ category_id: "games", category_group_id: "dead" })).toMatch(/No such category group.*Fun \(id fun\)/);
    expect(refuse({ category_id: "games", name: "Games", category_group_id: "fun" })).toMatch(/Nothing/);
  });

  test("a deleted category's name is free", () => {
    expect(changeBody({ category_id: "games", name: "Gone" }, groups())).toHaveProperty("body");
  });
});

describe("updateCategories", () => {
  test("PATCHes each valid change, reports before/after, and keeps going after a failure", async () => {
    const all = groups().flatMap((g) => g.categories ?? []);
    const updateCategory = vi.fn(async (_p: string, id: string, body: { name?: string; category_group_id?: string }) => {
      if (id === "netflix") throw new YnabError(400, "bad");
      return { data: { category: { ...all.find((c) => c.id === id)!, ...body } } };
    });
    const client = {
      listCategories: async () => ({ data: { category_groups: groups() } }),
      updateCategory,
    } as unknown as YnabClient;
    const out = await updateCategories(client, "plan", [
      { category_id: "games", name: "Gaming", category_group_id: "subs" },
      { category_id: "netflix", name: "Netflix Premium" },
      // Sees the rename above within the same batch.
      { category_id: "netflix", name: "gaming" },
    ]);
    UpdateCategoriesResultSchema.parse(out);
    expect(updateCategory.mock.calls).toEqual([
      ["plan", "games", { name: "Gaming", category_group_id: "subs" }],
      ["plan", "netflix", { name: "Netflix Premium" }],
    ]);
    expect(out.results).toMatchObject([
      { ok: true, before_name: "Games", after_name: "Gaming", before_group: "Fun", after_group: "Monthly Subscriptions" },
      { ok: false, error: "YNAB 400: bad" },
      { ok: false, error: expect.stringMatching(/"Gaming" \(id games, in Monthly Subscriptions\)/) },
    ]);
    expect(renderUpdateCategories(out)).toContain('[ok] "Games" → "Gaming", moved Fun → Monthly Subscriptions');
  });
});
