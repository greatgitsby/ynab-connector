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
  "get_month",
  "list_accounts",
  "list_months",
  "list_payees",
  "list_plans",
  "list_transactions",
  "reconcile_account",
  "reflect_income_expense",
  "reflect_net_worth",
  "triage_inbox",
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
    const writes = new Set(["assign_to_categories", "update_transactions", "reconcile_account"]);
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
              currency_format: { iso_code: "USD", decimal_digits: 2 },
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
    expect(fetchMock).not.toHaveBeenCalled();
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
