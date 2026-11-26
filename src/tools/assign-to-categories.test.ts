import { describe, test, expect, vi } from "bun:test";
import {
  YnabError,
  type Category,
  type MonthDetail,
  type YnabClient,
} from "../ynab";
import {
  applyAssignToCategories,
  expandFundUnderfunded,
  planMoves,
  toAssignMove,
  type AssignMoveOk,
  type AssignToCategoriesResult,
} from "./assign-to-categories";

const cat = (
  over: Partial<Category> & { id: string; name: string },
): Category => ({
  category_group_id: "grp-1",
  category_group_name: "Bills",
  hidden: false,
  internal: false,
  deleted: false,
  budgeted: 100000,
  activity: 0,
  balance: 100000,
  goal_type: null,
  goal_target: null,
  goal_under_funded: null,
  ...over,
});

const need = (
  id: string,
  name: string,
  budgeted: number,
  underfunded: number,
) =>
  cat({
    id,
    name,
    budgeted,
    balance: budgeted,
    goal_type: "NEED",
    goal_target: budgeted + underfunded,
    goal_cadence: 1,
    goal_cadence_frequency: 1,
    goal_under_funded: underfunded,
  });

const month = (categories: Category[], rta = 1_000_000): MonthDetail => ({
  month: "2026-05-01",
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: rta,
  age_of_money: null,
  deleted: false,
  categories,
});

const detail = month([
  cat({ id: "cat-a", name: "🛒 Groceries", budgeted: 400000, balance: 400000 }),
  cat({ id: "cat-b", name: "Dining", budgeted: 200000, balance: 150000 }),
  need("cat-n", "🎥 Netflix", 0, 9820),
  need("cat-s", "Spotify", 5000, 9190),
  cat({ id: "cat-h", name: "Hidden thing", hidden: true }),
]);
const months = new Map([["2026-05-01", detail]]);

describe("planMoves", () => {
  test("set, add, and fund_goal compute before/after; names resolve", () => {
    const r = planMoves(
      [
        {
          month: "2026-05-01",
          category: "groceries",
          op: { kind: "set", amount: 450000 },
        },
        {
          month: "2026-05-01",
          category: "cat-b",
          op: { kind: "add", amount: -50000 },
        },
        { month: "2026-05-01", category: "Netflix", op: { kind: "fund_goal" } },
      ],
      months,
    );
    expect(r).toEqual([
      expect.objectContaining({
        ok: true,
        category_id: "cat-a",
        before_budgeted: 400000,
        after_budgeted: 450000,
        change: 50000,
        balance: 450000,
      }),
      expect.objectContaining({
        ok: true,
        category_id: "cat-b",
        before_budgeted: 200000,
        after_budgeted: 150000,
        change: -50000,
        balance: 100000,
      }),
      expect.objectContaining({
        ok: true,
        category_id: "cat-n",
        before_budgeted: 0,
        after_budgeted: 9820,
        change: 9820,
      }),
    ]);
  });

  test("a second move on one category sees the first", () => {
    const r = planMoves(
      [
        {
          month: "2026-05-01",
          category: "cat-s",
          op: { kind: "add", amount: 1000 },
        },
        { month: "2026-05-01", category: "cat-s", op: { kind: "fund_goal" } },
      ],
      months,
    ) as AssignMoveOk[];
    expect(r[1].before_budgeted).toBe(6000);
    expect(r[1].after_budgeted).toBe(14190);
  });

  test("unknown names, goal-less fund_goal, and ambiguous names fail per move", () => {
    const dup = new Map([
      [
        "2026-05-01",
        month([
          ...detail.categories,
          cat({ id: "cat-d2", name: "Dining", category_group_name: "Fun" }),
        ]),
      ],
    ]);
    const r = planMoves(
      [
        {
          month: "2026-05-01",
          category: "Nope",
          op: { kind: "set", amount: 1 },
        },
        { month: "2026-05-01", category: "cat-a", op: { kind: "fund_goal" } },
        {
          month: "2026-05-01",
          category: "Dining",
          op: { kind: "set", amount: 1 },
        },
        {
          month: "2026-05-01",
          category: "Fun: Dining",
          op: { kind: "set", amount: 1 },
        },
      ],
      dup,
    );
    expect(r.map((x) => x.ok)).toEqual([false, false, false, true]);
    expect(r[2]).toMatchObject({
      error: expect.stringContaining("matches 2 categories"),
    });
  });
});

describe("expandFundUnderfunded", () => {
  test("funds every underfunded visible goal except named ones", () => {
    const r = expandFundUnderfunded("2026-05-01", detail, [], new Set());
    expect("moves" in r && r.moves.map((m) => m.category)).toEqual([
      "cat-n",
      "cat-s",
    ]);
    const ex = expandFundUnderfunded(
      "2026-05-01",
      detail,
      ["netflix"],
      new Set(),
    );
    expect("moves" in ex && ex.moves.map((m) => m.category)).toEqual(["cat-s"]);
  });

  test("an except name that matches nothing refuses the call", () => {
    const r = expandFundUnderfunded(
      "2026-05-01",
      detail,
      ["Netflx"],
      new Set(),
    );
    expect(r).toEqual({
      error: expect.stringContaining('No category matches "Netflx"'),
    });
  });
});

describe("toAssignMove", () => {
  test("maps the tool's fields to one op", () => {
    expect(
      toAssignMove({
        month: "current",
        category_name: "X",
        add_milliunits: -5,
      }),
    ).toEqual({
      month: "current",
      category: "X",
      op: { kind: "add", amount: -5 },
    });
    expect(
      toAssignMove({ month: "current", category_id: "c", fund_goal: true }).op,
    ).toEqual({ kind: "fund_goal" });
  });
});

const stubClient = (opts: { fail?: string; rtaAfter?: number } = {}) => {
  const patches: [string, string, number][] = [];
  let reads = 0;
  const client = {
    getMonth: vi.fn(async () => {
      reads += 1;
      return {
        data: {
          month:
            reads === 1
              ? detail
              : { ...detail, to_be_budgeted: opts.rtaAfter ?? 0 },
        },
      };
    }),
    updateCategoryMonth: vi.fn(
      async (_p: string, m: string, id: string, body: { budgeted: number }) => {
        if (id === opts.fail) throw new YnabError(404, "category not found");
        patches.push([m, id, body.budgeted]);
        return {
          data: {
            category: cat({
              id,
              name: id,
              budgeted: body.budgeted,
              balance: body.budgeted,
            }),
          },
        };
      },
    ),
  };
  return { client: client as unknown as YnabClient, patches };
};

describe("applyAssignToCategories", () => {
  test("writes changed moves, skips no-ops, and re-reads Ready to Assign", async () => {
    const { client, patches } = stubClient({ rtaAfter: 940000 });
    const out = (await applyAssignToCategories(client, "p", {
      moves: [
        {
          month: "2026-05-01",
          category: "cat-a",
          op: { kind: "add", amount: 60000 },
        },
        {
          month: "2026-05-01",
          category: "cat-b",
          op: { kind: "set", amount: 200000 },
        },
      ],
      dryRun: false,
    })) as AssignToCategoriesResult;
    expect(patches).toEqual([["2026-05-01", "cat-a", 460000]]);
    expect(out.results.map((r) => r.ok)).toEqual([true, true]);
    expect(out.ready_to_assign).toEqual([
      { month: "2026-05-01", before: 1_000_000, after: 940000 },
    ]);
  });

  test("dry run writes nothing and projects Ready to Assign", async () => {
    const { client, patches } = stubClient();
    const out = (await applyAssignToCategories(client, "p", {
      moves: [],
      fundUnderfunded: { month: "2026-05-01", except: ["spotify"] },
      dryRun: true,
    })) as AssignToCategoriesResult;
    expect(patches).toEqual([]);
    expect(out.dry_run).toBe(true);
    expect(out.results).toEqual([
      expect.objectContaining({ category_id: "cat-n", change: 9820 }),
    ]);
    expect(out.ready_to_assign).toEqual([
      { month: "2026-05-01", before: 1_000_000, after: 990180 },
    ]);
  });

  test("fund_underfunded skips categories the explicit moves already cover", async () => {
    const { client, patches } = stubClient();
    await applyAssignToCategories(client, "p", {
      moves: [
        {
          month: "2026-05-01",
          category: "cat-n",
          op: { kind: "set", amount: 1000 },
        },
      ],
      fundUnderfunded: { month: "2026-05-01", except: [] },
      dryRun: false,
    });
    expect(patches).toEqual([
      ["2026-05-01", "cat-n", 1000],
      ["2026-05-01", "cat-s", 14190],
    ]);
  });

  test("a failed PATCH doesn't stop the rest", async () => {
    const { client } = stubClient({ fail: "cat-a" });
    const out = (await applyAssignToCategories(client, "p", {
      moves: [
        {
          month: "2026-05-01",
          category: "cat-a",
          op: { kind: "set", amount: 1 },
        },
        {
          month: "2026-05-01",
          category: "cat-b",
          op: { kind: "set", amount: 1 },
        },
      ],
      dryRun: false,
    })) as AssignToCategoriesResult;
    expect(out.results[0]).toMatchObject({
      ok: false,
      error: "YNAB 404: category not found",
    });
    expect(out.results[1].ok).toBe(true);
  });
});
