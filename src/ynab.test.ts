import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { YnabClient, YnabError } from "./ynab";

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
        "https://api.ynab.com/v1/budgets/bud-1/months/2026-05-01/categories/cat-1",
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

  describe("updateTransaction", () => {
    test("PUTs the transaction endpoint with a wrapped body", async () => {
      stub = stubFetch(() =>
        okResponse({ data: { transaction: { id: "tx-1" } } }),
      );
      const client = new YnabClient("tok");
      await client.updateTransaction("bud-1", "tx-1", {
        category_id: "cat-x",
        approved: true,
      });

      const [{ url, init }] = stub.calls;
      expect(url).toBe(
        "https://api.ynab.com/v1/budgets/bud-1/transactions/tx-1",
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({
        transaction: { category_id: "cat-x", approved: true },
      });
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
      expect(url).toBe("https://api.ynab.com/v1/budgets/bud-1/transactions");
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
      expect(url).toBe("https://api.ynab.com/v1/budgets/bud-1/payees");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(res.data.payees).toHaveLength(1);
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

    test("refreshes the token on 401 and retries once", async () => {
      let firstCall = true;
      stub = stubFetch(() => {
        if (firstCall) {
          firstCall = false;
          return errResponse(401, "expired");
        }
        return okResponse({ data: { payees: [] } });
      });
      const refresh = vi.fn().mockResolvedValue("new-tok");
      const client = new YnabClient("old-tok", refresh);
      await client.listPayees("bud-1");

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(stub.calls).toHaveLength(2);
      const [first, second] = stub.calls;
      expect((first.init.headers as Record<string, string>)["Authorization"])
        .toBe("Bearer old-tok");
      expect((second.init.headers as Record<string, string>)["Authorization"])
        .toBe("Bearer new-tok");
    });
  });
});
