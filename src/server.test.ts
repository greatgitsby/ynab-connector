import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "./server";
import type { Props } from "./ynab-auth";

// Drives the real MCP server through an SDK v2 client, the way a remote MCP client does:
// tool discovery, schema validation, and tool calls end-to-end, with only the
// YNAB HTTP API stubbed.

const props = (overrides: Partial<Props> = {}): Props => ({
  ynabUserId: "user-1",
  ynabAccessToken: "ynab-access",
  ynabRefreshToken: "ynab-refresh",
  ynabExpiresAt: Math.floor(Date.now() / 1000) + 7200,
  canWrite: true,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
const requestedUrls = () =>
  fetchMock.mock.calls.map(([u]) => new URL(String(u)));

const connect = async (p: Props = props()) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(p).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const EXPECTED_TOOLS = [
  "assign_to_categories",
  "create_categories",
  "find_recurring_charges",
  "get_category",
  "get_month",
  "get_snapshot",
  "list_accounts",
  "list_money_movements",
  "list_months",
  "list_payees",
  "list_plans",
  "list_scheduled_transactions",
  "list_transactions",
  "merge_payees",
  "query_transactions",
  "reconcile_account",
  "reflect_income_expense",
  "reflect_net_worth",
  "rename_payees",
  "review_payees",
  "set_category_goals",
  "suggest_split",
  "triage_inbox",
  "update_categories",
  "update_transactions",
];

describe("tool discovery", () => {
  test("registers every tool under its Plan-vocabulary name", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  test("advertises server identity and instructions", async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe("YNAB");
    expect(client.getInstructions()).toContain("list_plans");
  });

  test("plan_id is optional everywhere and defaults to last-used", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const scoped = tools.filter((t) => t.name !== "list_plans");
    for (const t of scoped) {
      const props = t.inputSchema.properties as Record<string, { default?: unknown }>;
      expect(props.plan_id, t.name).toBeDefined();
      expect(props.plan_id.default, t.name).toBe("last-used");
      expect(t.inputSchema.required ?? [], t.name).not.toContain("plan_id");
    }
  });

  test("no tool surface still says 'budget' outside YNAB wire-field names", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const surface = JSON.stringify(tools)
      // YNAB field names, the brand, and the on/off-budget account concept.
      .replace(/goal_months_to_budget|budgeted|on_budget|(on|off)Budget|You Need A Budget|(on|off)[- ]budget/gi, "");
    expect(surface).not.toMatch(/budget/i);
  });

  test("read tools are annotated read-only; write tools are not", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const writes = new Set([
      "assign_to_categories",
      "update_transactions",
      "reconcile_account",
      "rename_payees",
      "merge_payees",
      "set_category_goals",
      "create_categories",
      "update_categories",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(!writes.has(t.name));
    }
  });
});

describe("tool calls", () => {
  test("list_plans hits /plans and returns text + structured content", async () => {
    fetchMock.mockResolvedValue(
      json({
        data: {
          plans: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              name: "Household",
              last_modified_on: "2026-10-30T12:00:00Z",
              first_month: "2024-01-01",
              last_month: "2026-11-01",
              date_format: { format: "MM/DD/YYYY" },
              currency_format: {
                iso_code: "USD",
                example_format: "123,456.78",
                decimal_digits: 2,
                decimal_separator: ".",
                symbol_first: true,
                group_separator: ",",
                currency_symbol: "$",
                display_symbol: true,
              },
            },
          ],
          default_plan: null,
        },
      }),
    );
    const client = await connect();
    const res = await client.callTool({ name: "list_plans", arguments: {} });

    expect(res.isError).toBeFalsy();
    expect(requestedUrls()[0].pathname).toBe("/v1/plans");
    const [{ headers }] = fetchMock.mock.calls.map(([, init]) => init);
    expect(headers.Authorization).toBe("Bearer ynab-access");
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Household");
    expect(res.structuredContent).toMatchObject({
      plans: [expect.objectContaining({ name: "Household" })],
    });
  });

  test("omitting plan_id targets YNAB's last-used plan", async () => {
    fetchMock.mockResolvedValue(json({ data: { payees: [] } }));
    const client = await connect();
    const res = await client.callTool({ name: "list_payees", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(requestedUrls()[0].pathname).toBe("/v1/plans/last-used/payees");
  });

  test("triage_inbox asks YNAB for full history, not the 1-year default", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      const url = new URL(u);
      if (url.pathname.endsWith("/transactions")) return json({ data: { transactions: [] } });
      if (url.pathname.endsWith("/settings"))
        return json({ data: { settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } } });
      if (url.pathname.includes("/months/"))
        return json({
          data: {
            month: {
              month: "2026-11-01",
              income: 0,
              budgeted: 0,
              activity: 0,
              to_be_budgeted: 0,
              age_of_money: null,
              categories: [],
            },
          },
        });
      return json({ data: { accounts: [] } });
    });
    const client = await connect();
    const res = await client.callTool({ name: "triage_inbox", arguments: { plan_id: "p1" } });
    expect(res.isError).toBeFalsy();
    const txUrls = requestedUrls().filter((u) => u.pathname === "/v1/plans/p1/transactions");
    expect(txUrls.length).toBeGreaterThan(0);
    for (const u of txUrls) expect(u.searchParams.get("since_date")).toBe("1900-01-01");
  });

  test("triage_inbox accepts undeclared YNAB fields and skips tracking accounts", async () => {
    // Shapes as YNAB v1.88 actually sends them, `*_formatted` siblings included.
    const wireTx = (id: string, account_id: string) => ({
      id,
      date: "2026-11-01",
      amount: -10,
      amount_formatted: "-$0.01",
      amount_currency: -0.01,
      memo: null,
      cleared: "cleared",
      approved: true,
      flag_color: null,
      flag_name: null,
      account_id,
      account_name: account_id,
      payee_id: null,
      payee_name: "Fidelity",
      category_id: null,
      category_name: "Uncategorized",
      transfer_account_id: null,
      transfer_transaction_id: null,
      matched_transaction_id: null,
      import_id: null,
      import_payee_name: null,
      import_payee_name_original: null,
      debt_transaction_type: null,
      deleted: false,
      subtransactions: [],
    });
    const wireAccount = (id: string, on_budget: boolean, closed: boolean) => ({
      id,
      name: id,
      type: on_budget ? "checking" : "otherAsset",
      on_budget,
      closed,
      note: null,
      balance: 0,
      balance_formatted: "$0.00",
      balance_currency: 0,
      cleared_balance: 0,
      uncleared_balance: 0,
      transfer_payee_id: null,
      deleted: false,
    });
    fetchMock.mockImplementation(async (u: string) => {
      const url = new URL(u);
      if (url.pathname.endsWith("/transactions"))
        return json({
          data: {
            transactions:
              url.searchParams.get("type") === "uncategorized"
                ? [wireTx("t-bank", "checking"), wireTx("t-401k", "fidelity-401k")]
                : [],
          },
        });
      if (url.pathname.endsWith("/settings"))
        return json({ data: { settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } } });
      if (url.pathname.includes("/months/"))
        return json({
          data: {
            month: {
              month: "2026-11-01",
              income: 0,
              budgeted: 0,
              activity: 0,
              to_be_budgeted: 0,
              to_be_budgeted_formatted: "$0.00",
              age_of_money: null,
              deleted: false,
              categories: [],
            },
          },
        });
      return json({
        data: {
          accounts: [
            wireAccount("checking", true, false),
            // Closed accounts still own transactions, so they still count.
            wireAccount("fidelity-401k", false, true),
          ],
        },
      });
    });
    const client = await connect();
    // The client validates structuredContent only against output schemas it
    // cached from listTools, which is how remote clients behave.
    await client.listTools();
    const res = await client.callTool({ name: "triage_inbox", arguments: { plan_id: "p1" } });
    expect(res.isError).toBeFalsy();
    const inbox = res.structuredContent as { uncategorized: { id: string }[] };
    expect(inbox.uncategorized.map((t) => t.id)).toEqual(["t-bank"]);
  });

  test("YNAB failures come back as tool errors (isError: true)", async () => {
    fetchMock.mockResolvedValue(json({ error: { id: "404.2", name: "resource_not_found" } }, 404));
    const client = await connect();
    const res = await client.callTool({ name: "list_payees", arguments: { plan_id: "nope" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("YNAB error 404");
  });

  test("write tools refuse legacy read-only grants before calling YNAB", async () => {
    const client = await connect(props({ canWrite: undefined }));
    const res = await client.callTool({
      name: "assign_to_categories",
      arguments: {
        moves: [{ month: "current", category_id: "c1", set_budgeted_milliunits: 1000 }],
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("read-only");
    // A goal preview reads YNAB, so it is gated too.
    const goals = await client.callTool({
      name: "set_category_goals",
      arguments: { changes: [{ category_id: "c1", remove_goal: true }] },
    });
    expect(goals.isError).toBe(true);
    expect((goals.content as Array<{ text: string }>)[0].text).toContain("read-only");
    // A split GETs the transaction first, so it is gated before that read.
    const split = await client.callTool({
      name: "update_transactions",
      arguments: {
        updates: [
          {
            transaction_id: "t1",
            subtransactions: [
              { amount_milliunits: -14190, category_id: "c1" },
              { amount_milliunits: -9820, category_id: "c2" },
            ],
          },
        ],
      },
    });
    expect(split.isError).toBe(true);
    expect((split.content as Array<{ text: string }>)[0].text).toContain("read-only");
    for (const [name, args] of [
      ["create_categories", { categories: [{ category_group_id: "g1", name: "Claude" }] }],
      ["update_categories", { changes: [{ category_id: "c1", name: "Claude" }] }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      expect((res.content as Array<{ text: string }>)[0].text, name).toContain("read-only");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("set_category_goals previews by default, then PATCHes only with apply: true", async () => {
    const counseling = {
      id: "c1",
      category_group_id: "g1",
      name: "Piano Lessons",
      hidden: false,
      internal: false,
      deleted: false,
      budgeted: 0,
      activity: 0,
      balance: 0,
      goal_type: "NEED",
      goal_target: 350000,
      goal_cadence: 1,
      goal_cadence_frequency: 1,
      goal_needs_whole_amount: true,
    };
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      const path = new URL(u).pathname;
      if (init?.method === "PATCH")
        return json({ data: { category: { ...counseling, goal_type: null, goal_target: 0 } } });
      if (path.endsWith("/settings"))
        return json({ data: { settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } } });
      return json({
        data: { category_groups: [{ id: "g1", name: "Fixed", hidden: false, deleted: false, categories: [counseling] }] },
      });
    });
    const client = await connect();
    const args = { changes: [{ category_id: "c1", remove_goal: true }] };
    const preview = await client.callTool({ name: "set_category_goals", arguments: args });
    expect(preview.isError).toBeFalsy();
    expect((preview.content as Array<{ text: string }>)[0].text).toContain("nothing changed yet");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);

    const applied = await client.callTool({ name: "set_category_goals", arguments: { ...args, apply: true } });
    expect(applied.structuredContent).toMatchObject({
      applied: true,
      results: [{ ok: true, before: "$350.00/month", after: null }],
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(new URL(patch[0]).pathname).toBe("/v1/plans/last-used/categories/c1");
    expect(JSON.parse(patch[1].body)).toEqual({ category: { goal_target: null } });
  });

  test("merge_payees previews by default and writes nothing", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") throw new Error(`unexpected ${init.method}`);
      const path = new URL(u).pathname;
      if (path.endsWith("/settings"))
        return json({ data: { settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } } });
      if (path.endsWith("/payees"))
        return json({
          data: {
            payees: [
              { id: "keep", name: "Starbucks", transfer_account_id: null, deleted: false },
              { id: "dup", name: "STARBUCKS #1", transfer_account_id: null, deleted: false },
            ],
          },
        });
      if (path.endsWith("/scheduled_transactions")) return json({ data: { scheduled_transactions: [] } });
      return json({
        data: {
          transactions: [
            {
              id: "t1",
              date: "2026-10-01",
              amount: -5000,
              memo: null,
              cleared: "cleared",
              approved: true,
              flag_color: null,
              account_id: "a",
              account_name: "Checking",
              payee_id: "dup",
              payee_name: "STARBUCKS #1",
              category_id: null,
              category_name: null,
              transfer_account_id: null,
              deleted: false,
              subtransactions: [],
            },
          ],
        },
      });
    });
    const client = await connect();
    const res = await client.callTool({
      name: "merge_payees",
      arguments: { target_payee_id: "keep", source_payee_ids: ["dup"] },
    });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toContain("nothing changed yet");
    expect(res.structuredContent).toMatchObject({
      applied: false,
      sources: [{ payee_id: "dup", transactions: [{ id: "t1" }] }],
    });
  });

  describe("against one small plan", () => {
    const category = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      category_group_id: "g1",
      category_group_name: "Subscriptions",
      name,
      hidden: false,
      internal: false,
      deleted: false,
      budgeted: 0,
      activity: 0,
      balance: 0,
      ...extra,
    });
    const categories = [
      category("c-net", "🎥 Netflix", { goal_type: "NEED", goal_target: 9820, goal_cadence: 1, goal_cadence_frequency: 1, goal_under_funded: 9820 }),
      category("c-spo", "Spotify", { goal_type: "NEED", goal_target: 14190, goal_cadence: 1, goal_cadence_frequency: 1 }),
      category("c-food", "Groceries", { balance: -5000 }),
    ];
    const tx = (id: string, date: string, amount: number, extra: Record<string, unknown> = {}) => ({
      id,
      date,
      amount,
      memo: null,
      cleared: "cleared",
      approved: true,
      flag_color: null,
      account_id: "a1",
      account_name: "Checking",
      payee_id: "p-priv",
      payee_name: "Virtual Card",
      category_id: "c-net",
      category_name: "🎥 Netflix",
      transfer_account_id: null,
      import_id: `YNAB:${id}`,
      deleted: false,
      subtransactions: [],
      ...extra,
    });
    const transactions = [
      tx("t1", "2026-08-09", -9820),
      tx("t2", "2026-09-09", -9820),
      tx("t3", "2026-10-09", -9820),
      tx("t4", "2026-10-10", -14190, { category_id: "c-spo", category_name: "Spotify" }),
      tx("t5", "2026-11-09", -24010, { category_id: null, category_name: null, approved: false }),
      tx("t6", "2026-11-02", -5000, {
        payee_id: "p-store",
        payee_name: "Store",
        category_id: null,
        category_name: "Split",
        memo: "weekly shop",
        subtransactions: [
          { id: "s1", transaction_id: "t6", amount: -3000, memo: null, payee_id: null, payee_name: null, category_id: "c-food", category_name: "Groceries", transfer_account_id: null, deleted: false },
          { id: "s2", transaction_id: "t6", amount: -2000, memo: null, payee_id: null, payee_name: null, category_id: "c-net", category_name: "🎥 Netflix", transfer_account_id: null, deleted: false },
        ],
      }),
    ];
    const month = { month: "2026-11-01", note: null, income: 0, budgeted: 0, activity: 0, to_be_budgeted: 7000, age_of_money: 30, deleted: false, categories };

    beforeEach(() => {
      fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
        const path = new URL(u).pathname;
        if (init?.method === "PATCH" && path.endsWith("/transactions")) {
          const body = JSON.parse(String(init.body));
          return json({ data: { transaction_ids: ["t5"], transactions: [{ ...transactions[4], ...body.transactions[0], category_name: "Spotify" }] } });
        }
        if (init?.method === "PATCH")
          return json({ data: { category: { ...categories[0], budgeted: 9820, balance: 9820 } } });
        if (path.endsWith("/settings"))
          return json({ data: { settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } } });
        if (path.endsWith("/categories"))
          return json({ data: { category_groups: [{ id: "g1", name: "Subscriptions", hidden: false, internal: false, deleted: false, categories }] } });
        if (path.endsWith("/payees"))
          return json({ data: { payees: [{ id: "p-priv", name: "Virtual Card", transfer_account_id: null, deleted: false }] } });
        if (path.endsWith("/accounts"))
          return json({ data: { accounts: [{ id: "a1", name: "Checking", type: "checking", on_budget: true, closed: false, note: null, balance: 1000, cleared_balance: 900, uncleared_balance: 100, transfer_payee_id: null, deleted: false }] } });
        if (path.includes("/months/")) return json({ data: { month } });
        if (path.endsWith("/scheduled_transactions")) return json({ data: { scheduled_transactions: [] } });
        if (path.endsWith("/transactions/t5")) return json({ data: { transaction: transactions[4] } });
        return json({ data: { transactions } });
      });
    });

    const call = async (name: string, args: Record<string, unknown>) => {
      const client = await connect();
      // Caches output schemas, so the client validates structuredContent.
      await client.listTools();
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      return res.structuredContent as Record<string, any>;
    };

    test("query_transactions resolves names, groups, and pages", async () => {
      const q = await call("query_transactions", { categories: ["netflix"], group_by: "month", limit: 2 });
      expect(q.matched.categories).toEqual([{ id: "c-net", name: "🎥 Netflix" }]);
      expect(q.count).toBe(4);
      expect(q.groups.map((g: { key: string }) => g.key)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"]);
      expect(q.rows).toEqual([
        { id: "t6", part_id: "s2", date: "2026-11-02", amount: -2000, payee: "Store", category: "🎥 Netflix", account: "Checking", memo: "weekly shop" },
        expect.objectContaining({ id: "t3" }),
      ]);
      expect(q.next_offset).toBe(2);
      expect(requestedUrls().some((u) => u.pathname.endsWith("/categories"))).toBe(true);
    });

    test("month: current becomes this month's date range", async () => {
      await call("query_transactions", { month: "current" });
      const u = requestedUrls().find((x) => x.pathname.endsWith("/transactions"))!;
      expect(u.searchParams.get("since_date")).toMatch(/^\d{4}-\d{2}-01$/);
      expect(u.searchParams.get("until_date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("an unknown name is a tool error, not an empty result", async () => {
      const client = await connect();
      const res = await client.callTool({ name: "query_transactions", arguments: { payees: ["Nobody"] } });
      expect(res.isError).toBe(true);
    });

    test("find_recurring_charges, get_snapshot, suggest_split, and compact get_month fit their schemas", async () => {
      const rec = await call("find_recurring_charges", { since_date: "2026-01-01", include_lapsed: true });
      expect(rec.series).toEqual([expect.objectContaining({ payee: "Virtual Card", cadence: "monthly", typical_amount: -9820 })]);
      const snap = await call("get_snapshot", { recent_days: 60 });
      expect(snap.ready_to_assign).toBe(7000);
      expect(snap.accounts[0]).toMatchObject({ cleared: 900, working: 1000 });
      const split = await call("suggest_split", { transaction_id: "t5" });
      expect(split.suggestions[0].subtransactions).toEqual([
        { amount_milliunits: -14190, category_id: "c-spo" },
        { amount_milliunits: -9820, category_id: "c-net" },
      ]);
      const m = await call("get_month", { only: ["underfunded", "overspent"], compact: true });
      expect(m.groups).toBeUndefined();
      expect(m.categories.map((c: { id: string }) => c.id)).toEqual(["c-net", "c-food"]);
    });

    test("update_transactions sends the id a category_name resolves to and reports balances", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "update_transactions",
        arguments: { updates: [{ transaction_id: "t5", category_name: "spotify", approved: true }] },
      });
      expect(res.isError).toBeFalsy();
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
      expect(JSON.parse(patch[1].body).transactions[0]).toEqual({ id: "t5", category_id: "c-spo", approved: true });
      expect(res.structuredContent).toMatchObject({
        ready_to_assign: 7000,
        category_balances: [{ id: "c-spo", name: "Spotify" }],
      });
    });

    test("assign_to_categories funds a goal by name", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "assign_to_categories",
        arguments: { moves: [{ category_name: "Netflix", fund_goal: true }] },
      });
      expect(res.isError).toBeFalsy();
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
      expect(new URL(patch[0]).pathname).toBe("/v1/plans/last-used/months/2026-11-01/categories/c-net");
      expect(JSON.parse(patch[1].body)).toEqual({ category: { budgeted: 9820 } });
    });
  });

  test("invalid arguments are rejected by schema validation", async () => {
    const client = await connect();
    const res = await client
      .callTool({ name: "list_transactions", arguments: { since_date: "last tuesday" } })
      .catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
