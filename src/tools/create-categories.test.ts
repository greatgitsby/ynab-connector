import { describe, test, expect, vi } from "bun:test";
import { YnabError, type Category, type YnabClient } from "../ynab";
import {
  CreateCategoriesResultSchema,
  createCategories,
  newCategoryBody,
  renderCreateCategories,
} from "./create-categories";
import { groups } from "./categories.fixture";

const M = "2026-11-01";

describe("newCategoryBody", () => {
  test("sends name and group, plus any goal fields", () => {
    expect(
      newCategoryBody(
        { category_group_id: "subs", name: "Claude" },
        groups(),
        M,
      ),
    ).toEqual({
      body: { name: "Claude", category_group_id: "subs" },
    });
    expect(
      newCategoryBody(
        {
          category_group_id: "subs",
          name: "Google One",
          goal_target: 29990,
          goal_frequency: "yearly",
        },
        groups(),
        M,
      ),
    ).toEqual({
      body: {
        name: "Google One",
        category_group_id: "subs",
        goal_target: 29990,
        goal_frequency: "yearly",
      },
    });
  });

  test("refuses an unknown group, a taken name, and a goal without a target", () => {
    const refuse = (i: Parameters<typeof newCategoryBody>[0]) =>
      (newCategoryBody(i, groups(), M) as { error: string }).error;
    expect(refuse({ category_group_id: "dead", name: "X" })).toMatch(
      /No such category group/,
    );
    expect(refuse({ category_group_id: "fun", name: "NETFLIX" })).toMatch(
      /already has that name/,
    );
    expect(
      refuse({ category_group_id: "fun", name: "X", goal_frequency: "weekly" }),
    ).toMatch(/needs goal_target/);
    expect(
      refuse({
        category_group_id: "fun",
        name: "X",
        goal_target_date: "2027-01-01",
      }),
    ).toMatch(/needs goal_target/);
    expect(
      refuse({
        category_group_id: "fun",
        name: "X",
        goal_target: 1,
        goal_frequency: "weekly",
        goal_target_date: "2027-01-01",
      }),
    ).toMatch(/can't be combined/);
  });
});

describe("createCategories", () => {
  test("POSTs each valid item, reports the goal, and catches duplicates within the batch", async () => {
    const createCategory = vi.fn(
      async (
        _p: string,
        body: { name: string; category_group_id: string; goal_target?: number },
      ) => {
        if (body.name === "Boom") throw new YnabError(400, "bad");
        return {
          data: {
            category: {
              id: `new-${body.name}`,
              hidden: false,
              internal: false,
              deleted: false,
              budgeted: 0,
              activity: 0,
              balance: 0,
              ...body,
              ...(body.goal_target
                ? {
                    goal_type: "NEED",
                    goal_cadence: 1,
                    goal_cadence_frequency: 1,
                    goal_needs_whole_amount: true,
                  }
                : { goal_type: null, goal_target: 0 }),
            } as unknown as Category,
          },
        };
      },
    );
    const client = {
      planIso: async () => "USD",
      listCategories: async () => ({ data: { category_groups: groups() } }),
      createCategory,
    } as unknown as YnabClient;
    const out = await createCategories(client, "plan", [
      { category_group_id: "subs", name: "Claude", goal_target: 20000 },
      { category_group_id: "subs", name: "Boom" },
      { category_group_id: "fun", name: "claude" },
      { category_group_id: "subs", name: "Streaming Plus" },
    ]);
    CreateCategoriesResultSchema.parse(out);
    expect(createCategory).toHaveBeenCalledTimes(3);
    expect(out.results).toMatchObject([
      {
        ok: true,
        category_id: "new-Claude",
        group: "Monthly Subscriptions",
        goal: "$20.00/month",
      },
      { ok: false, name: "Boom", error: "YNAB 400: bad" },
      {
        ok: false,
        name: "claude",
        error: expect.stringMatching(/id new-Claude/),
      },
      { ok: true, name: "Streaming Plus", goal: null },
    ]);
    const text = renderCreateCategories(out);
    expect(text).toContain("## Created 2 / 4 categories (2 errors)");
    expect(text).toContain(
      '[ok] "Claude" in Monthly Subscriptions, goal $20.00/month — id new-Claude',
    );
  });
});
