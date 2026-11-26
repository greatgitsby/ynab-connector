import { describe, test, expect, vi } from "bun:test";
import { YnabError, type Category, type YnabClient } from "../ynab";
import {
  SetCategoryGoalsResultSchema,
  goalBody,
  renderSetCategoryGoals,
  setCategoryGoals,
} from "./set-category-goals";

const M = "2026-11-01";

const cat = (
  over: Partial<Category> & { id: string; name: string },
): Category =>
  ({
    category_group_id: "g1",
    hidden: false,
    internal: false,
    deleted: false,
    budgeted: 0,
    activity: 0,
    balance: 0,
    goal_type: null,
    goal_target: 0,
    ...over,
  }) as Category;

const need = cat({
  id: "need",
  name: "Piano Lessons",
  goal_type: "NEED",
  goal_target: 350000,
  goal_cadence: 1,
  goal_cadence_frequency: 1,
  goal_needs_whole_amount: true,
});
const tb = cat({
  id: "tb",
  name: "Vacation",
  goal_type: "TB",
  goal_target: 2000000,
});
const bare = cat({ id: "bare", name: "Gifts" });

describe("goalBody", () => {
  test("remove_goal sends goal_target: null", () => {
    expect(
      goalBody({ category_id: "need", remove_goal: true }, need, M),
    ).toEqual({
      body: { goal_target: null },
    });
  });

  test("sends only the fields given, including a null date to clear it", () => {
    expect(
      goalBody(
        {
          category_id: "need",
          goal_target: 400000,
          goal_target_date: null,
          goal_needs_whole_amount: false,
        },
        need,
        M,
      ),
    ).toEqual({
      body: {
        goal_target: 400000,
        goal_target_date: null,
        goal_needs_whole_amount: false,
      },
    });
    expect(
      goalBody(
        { category_id: "tb", goal_target: 50000, goal_frequency: "weekly" },
        tb,
        M,
      ),
    ).toEqual({ body: { goal_target: 50000, goal_frequency: "weekly" } });
  });

  test("refuses what YNAB would reject or silently mis-store", () => {
    const refuse = (
      c: Parameters<typeof goalBody>[0],
      on: Category | undefined,
    ) => (goalBody(c, on, M) as { error: string }).error;
    expect(refuse({ category_id: "x", remove_goal: true }, undefined)).toMatch(
      /No such/,
    );
    expect(
      refuse(
        { category_id: "d", remove_goal: true },
        { ...need, deleted: true },
      ),
    ).toMatch(/No such/);
    expect(
      refuse({ category_id: "i", goal_target: 1 }, { ...bare, internal: true }),
    ).toMatch(/internal/);
    expect(
      refuse({ category_id: "need", remove_goal: true, goal_target: 1 }, need),
    ).toMatch(/combined/);
    expect(refuse({ category_id: "bare", remove_goal: true }, bare)).toMatch(
      /no goal to remove/,
    );
    expect(refuse({ category_id: "need" }, need)).toMatch(/Nothing/);
    expect(
      refuse({ category_id: "need", goal_frequency: "weekly" }, need),
    ).toMatch(/needs goal_target/);
    expect(
      refuse(
        {
          category_id: "need",
          goal_target: 1,
          goal_frequency: "monthly",
          goal_target_date: "2027-01-01",
        },
        need,
      ),
    ).toMatch(/can't be combined/);
    expect(
      refuse({ category_id: "bare", goal_target_date: "2027-01-01" }, bare),
    ).toMatch(/give goal_target/);
    // YNAB accepts the flag on a TB goal and stores it meaninglessly.
    expect(
      refuse({ category_id: "tb", goal_needs_whole_amount: false }, tb),
    ).toMatch(/Plan Your Spending/);
  });

  test("goal_needs_whole_amount is allowed when the change makes a NEED goal", () => {
    expect(
      goalBody(
        {
          category_id: "bare",
          goal_target: 1000,
          goal_needs_whole_amount: false,
        },
        bare,
        M,
      ),
    ).toHaveProperty("body");
    expect(
      goalBody(
        {
          category_id: "tb",
          goal_target: 1000,
          goal_frequency: "monthly",
          goal_needs_whole_amount: true,
        },
        tb,
        M,
      ),
    ).toHaveProperty("body");
  });
});

describe("setCategoryGoals", () => {
  const client = () => {
    const updateCategory = vi.fn(
      async (
        _plan: string,
        id: string,
        body: { goal_target?: number | null },
      ) => {
        if (id === "tb") throw new YnabError(400, "bad");
        return {
          data: {
            category:
              body.goal_target === null
                ? { ...need, goal_type: null, goal_target: 0 }
                : {
                    ...bare,
                    goal_type: "NEED",
                    goal_target: body.goal_target,
                    goal_cadence: 1,
                    goal_cadence_frequency: 1,
                  },
          },
        };
      },
    );
    const c = {
      planIso: async () => "USD",
      listCategories: async () => ({
        data: {
          category_groups: [
            {
              id: "g1",
              name: "G",
              hidden: false,
              deleted: false,
              categories: [need, tb, bare],
            },
          ],
        },
      }),
      updateCategory,
    } as unknown as YnabClient;
    return { c, updateCategory };
  };
  const changes = [
    { category_id: "need", remove_goal: true },
    { category_id: "tb", goal_target: 5 },
    { category_id: "bare", goal_target: 25000 },
    { category_id: "bare", goal_needs_whole_amount: true },
  ];

  test("a preview sends nothing", async () => {
    const { c, updateCategory } = client();
    const out = await setCategoryGoals(c, "plan", changes, false);
    expect(updateCategory).not.toHaveBeenCalled();
    SetCategoryGoalsResultSchema.parse(out);
    expect(out.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    const text = renderSetCategoryGoals(out);
    expect(text).toContain("nothing changed yet");
    expect(text).toContain(
      "Piano Lessons: $350.00/month; will remove the goal",
    );
    expect(text).toContain("apply: true");
  });

  test("apply PATCHes each valid change, reports before/after, and keeps going after a failure", async () => {
    const { c, updateCategory } = client();
    const out = await setCategoryGoals(c, "plan", changes, true);
    SetCategoryGoalsResultSchema.parse(out);
    expect(updateCategory.mock.calls).toEqual([
      ["plan", "need", { goal_target: null }],
      ["plan", "tb", { goal_target: 5 }],
      ["plan", "bare", { goal_target: 25000 }],
    ]);
    expect(out.results).toMatchObject([
      { ok: true, before: "$350.00/month", after: null },
      { ok: false, category_id: "tb", error: "YNAB 400: bad" },
      { ok: true, before: null, after: "$25.00/month" },
      { ok: false, error: expect.stringMatching(/give goal_target/) },
    ]);
    expect(renderSetCategoryGoals(out)).toContain(
      "[ok] Piano Lessons: $350.00/month → no goal",
    );
  });
});
