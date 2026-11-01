import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { ALL_TIME, YnabClient, YnabError } from "./ynab";

// Captures the args of each fetch call so we can assert on URL / method / body.
type FetchCall = { url: string; init: RequestInit };

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const errResponse = (status: number, body: string): Response =>
  new Response(body, { status });

const stubFetch = (
  responder: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } => {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

describe("YnabClient", () => {
  let stub: ReturnType<typeof stubFetch> | undefined;

  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  describe("updateCategoryMonth", () => {
    test("PATCHes the category endpoint with a wrapped body", async () => {
      stub = stubFetch(() => okResponse({ data: { category: { id: "cat-1" } } }));
      const client = new YnabClient("tok");
      const res = await client.updateCategoryMonth(
        "bud-1",
        "2026-05-01",
        "cat-1",
        { budgeted: 450000 },
      );

      expect(stub.calls).toHaveLength(1);
      const [{ url, init }] = stub.calls;
      expect(url).toBe(
        "https://api.ynab.com/v1/plans/bud-1/months/2026-05-01/categories/cat-1",
      );
      expect(init.method).toBe("PATCH");
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBe("Bearer tok");
      expect(JSON.parse(init.body as string)).toEqual({
        category: { budgeted: 450000 },
      });
      expect(res.data.category.id).toBe("cat-1");
    });
  });

  describe("listTransactions", () => {
    const urlFor = async (opts: Parameters<YnabClient["listTransactions"]>[1]) => {
      stub = stubFetch(() => okResponse({ data: { transactions: [] } }));
      await new YnabClient("tok").listTransactions("p1", opts);
      const url = new URL(stub.calls[0].url);
      stub.restore();
      return url;
    };

    // YNAB v1.85 defaults since_date to one year ago when omitted, so every
    // scope must send an explicit lower bound.
    test("routes each scope to its YNAB endpoint and always sends since_date", async () => {
      const cases: [Parameters<YnabClient["listTransactions"]>[1], string][] = [
        [{}, "/v1/plans/p1/transactions"],
        [{ accountId: "a1" }, "/v1/plans/p1/accounts/a1/transactions"],
        [{ categoryId: "c1" }, "/v1/plans/p1/categories/c1/transactions"],
        [{ payeeId: "y1" }, "/v1/plans/p1/payees/y1/transactions"],
        [{ month: "2026-05-01" }, "/v1/plans/p1/months/2026-05-01/transactions"],
      ];
      for (const [opts, path] of cases) {
        const url = await urlFor(opts);
        expect(url.pathname).toBe(path);
        expect(url.searchParams.get("since_date")).toBe(ALL_TIME);
      }
    });

    test("passes since_date, until_date, and type through", async () => {
      const url = await urlFor({
        payeeId: "y1",
        sinceDate: "2026-01-01",
        untilDate: "2026-06-30",
        type: "unapproved",
      });
      expect(url.searchParams.get("since_date")).toBe("2026-01-01");
      expect(url.searchParams.get("until_date")).toBe("2026-06-30");
      expect(url.searchParams.get("type")).toBe("unapproved");
    });
  });

  describe("updateTransactionsBulk", () => {
    test("PATCHes the bulk transactions endpoint with the body verbatim", async () => {
      stub = stubFetch(() =>
        okResponse({
          data: { transactions: [{ id: "tx-1" }], transaction_ids: ["tx-1"] },
        }),
      );
      const client = new YnabClient("tok");
      await client.updateTransactionsBulk("bud-1", {
        transactions: [
          { id: "tx-1", approved: true },
          {
            id: "tx-2",
            subtransactions: [
              { amount: -3000, category_id: "cat-a" },
              { amount: -2000, category_id: "cat-b" },
            ],
          },
        ],
      });

      const [{ url, init }] = stub.calls;
      expect(url).toBe("https://api.ynab.com/v1/plans/bud-1/transactions");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({
        transactions: [
          { id: "tx-1", approved: true },
          {
            id: "tx-2",
            subtransactions: [
              { amount: -3000, category_id: "cat-a" },
              { amount: -2000, category_id: "cat-b" },
            ],
          },
        ],
      });
    });
  });

  describe("listPayees", () => {
    test("GETs the payees endpoint", async () => {
      stub = stubFetch(() =>
        okResponse({
          data: {
            payees: [
              { id: "p1", name: "Starbucks", transfer_account_id: null },
            ],
          },
        }),
      );
      const client = new YnabClient("tok");
      const res = await client.listPayees("bud-1");

      const [{ url, init }] = stub.calls;
      expect(url).toBe("https://api.ynab.com/v1/plans/bud-1/payees");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(res.data.payees).toHaveLength(1);
    });
  });

  describe("plans", () => {
    test("listPlans hits /plans and returns the plans key", async () => {
      stub = stubFetch(() =>
        okResponse({ data: { plans: [{ id: "p1", name: "Home" }], default_plan: null } }),
      );
      const res = await new YnabClient("tok").listPlans();
      expect(stub.calls[0].url).toBe("https://api.ynab.com/v1/plans");
      expect(res.data.plans[0].id).toBe("p1");
    });

    test("getPlan hits /plans/{id}", async () => {
      stub = stubFetch(() =>
        okResponse({ data: { plan: { id: "p1", name: "Home" } } }),
      );
      const res = await new YnabClient("tok").getPlan("p1");
      expect(stub.calls[0].url).toBe("https://api.ynab.com/v1/plans/p1");
      expect(res.data.plan.name).toBe("Home");
    });

    test("accepts YNAB's last-used plan alias verbatim", async () => {
      stub = stubFetch(() => okResponse({ data: { accounts: [] } }));
      await new YnabClient("tok").listAccounts("last-used");
      expect(stub.calls[0].url).toBe(
        "https://api.ynab.com/v1/plans/last-used/accounts",
      );
    });
  });

  describe("error handling", () => {
    test("throws YnabError on a 4xx response", async () => {
      stub = stubFetch(() => errResponse(404, "Category not found"));
      const client = new YnabClient("tok");
      await expect(
        client.updateCategoryMonth("b", "2026-05-01", "c", { budgeted: 0 }),
      ).rejects.toMatchObject({
        status: 404,
        body: "Category not found",
      });
    });

    test("does not retry on 401 — token rotation lives in the OAuth layer", async () => {
      stub = stubFetch(() => errResponse(401, "expired"));
      const client = new YnabClient("old-tok");
      await expect(client.listPayees("bud-1")).rejects.toMatchObject({ status: 401 });
      expect(stub.calls).toHaveLength(1);
    });
  });
});
