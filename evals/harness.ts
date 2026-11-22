import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server";
import type { FixtureCategory, FixtureTx } from "./fixtures/subscription-scan";

// Evals drive the real MCP server through an SDK client, as an agent would.
// Only YNAB's HTTP API is faked, from a fixture plan, and the clock is frozen
// so cadence and status are deterministic. Nothing here talks to YNAB.

export const TODAY = "2026-11-22";

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export const categoryId = (name: string) => `c-${slug(name) || "x"}`;
export const payeeId = (name: string) => `p-${slug(name)}`;
const accountId = (name: string) => `a-${slug(name)}`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const wireTx = (t: FixtureTx) => {
  const account = t.account ?? "Apple Card";
  return {
    id: t.id,
    date: t.date,
    amount: t.amount,
    memo: t.memo ?? null,
    cleared: "cleared",
    approved: true,
    flag_color: null,
    flag_name: null,
    account_id: accountId(account),
    account_name: account,
    payee_id: payeeId(t.payee),
    payee_name: t.payee,
    category_id: t.parts ? null : t.category && categoryId(t.category),
    category_name: t.parts ? "Split" : t.category,
    transfer_account_id: t.transfer ? accountId("Savings") : null,
    transfer_transaction_id: null,
    matched_transaction_id: null,
    import_id: `YNAB:${t.amount}:${t.date}:1`,
    import_payee_name: null,
    import_payee_name_original: null,
    debt_transaction_type: null,
    deleted: false,
    subtransactions: (t.parts ?? []).map((p, i) => ({
      id: `${t.id}-s${i}`,
      transaction_id: t.id,
      amount: p.amount,
      memo: null,
      payee_id: null,
      payee_name: null,
      category_id: categoryId(p.category),
      category_name: p.category,
      transfer_account_id: null,
      transfer_transaction_id: null,
      deleted: false,
    })),
  };
};

const wireCategory = (c: FixtureCategory, txs: FixtureTx[], month: string) => {
  const activity = txs
    .filter((t) => t.date.startsWith(month.slice(0, 7)))
    .flatMap((t) => (t.parts ? t.parts : [{ amount: t.amount, category: t.category }]))
    .filter((p) => p.category === c.name)
    .reduce((a, p) => a + p.amount, 0);
  const budgeted = c.goal_target ?? 0;
  return {
    id: categoryId(c.name),
    category_group_id: `g-${slug(c.group)}`,
    category_group_name: c.group,
    name: c.name,
    hidden: false,
    internal: false,
    note: null,
    budgeted,
    activity,
    balance: budgeted + activity,
    goal_type: c.goal_target ? "NEED" : null,
    goal_target: c.goal_target ?? null,
    goal_cadence: c.goal_target ? 1 : null,
    goal_cadence_frequency: c.goal_target ? 1 : null,
    goal_under_funded: c.goal_target ? 0 : null,
    goal_overall_left: c.goal_target ? 0 : null,
    deleted: false,
  };
};

// A fetch that answers YNAB's endpoints from the fixture.
const fakeYnab = (txs: FixtureTx[], cats: FixtureCategory[]) => async (u: string | URL) => {
  const url = new URL(String(u));
  const path = url.pathname.replace(/^\/v1\/plans\/[^/]+/, "");
  if (path === "/settings")
    return json({ data: { settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } } });
  if (path === "/categories") {
    const groups = [...new Set(cats.map((c) => c.group))].map((g) => ({
      id: `g-${slug(g)}`,
      name: g,
      hidden: false,
      internal: false,
      deleted: false,
      categories: cats.filter((c) => c.group === g).map((c) => wireCategory(c, txs, TODAY)),
    }));
    return json({ data: { category_groups: groups } });
  }
  if (path === "/payees") {
    const names = [...new Set(txs.map((t) => t.payee))];
    return json({
      data: { payees: names.map((name) => ({ id: payeeId(name), name, transfer_account_id: null, deleted: false })) },
    });
  }
  if (path === "/accounts") {
    const names = [...new Set(txs.map((t) => t.account ?? "Apple Card"))];
    return json({
      data: {
        accounts: names.map((name) => ({
          id: accountId(name), name, type: "checking", on_budget: true, closed: false, note: null,
          balance: 0, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null, deleted: false,
        })),
      },
    });
  }
  if (path === "/scheduled_transactions") return json({ data: { scheduled_transactions: [] } });
  const one = path.match(/^\/transactions\/([^/]+)$/);
  if (one) {
    const t = txs.find((x) => x.id === one[1]);
    return t ? json({ data: { transaction: wireTx(t) } }) : json({ error: { id: "404.2", name: "resource_not_found" } }, 404);
  }
  const month = path.match(/^\/months\/([^/]+)$/);
  if (month) {
    const m = month[1] === "current" ? `${TODAY.slice(0, 7)}-01` : month[1];
    return json({
      data: {
        month: {
          month: m, note: null, income: 0, budgeted: 0, activity: 0, to_be_budgeted: 0, age_of_money: 30, deleted: false,
          categories: cats.map((c) => wireCategory(c, txs, m)),
        },
      },
    });
  }
  if (path.endsWith("/transactions")) {
    const since = url.searchParams.get("since_date") ?? "0000-00-00";
    const until = url.searchParams.get("until_date") ?? "9999-99-99";
    const acct = path.match(/^\/accounts\/([^/]+)\//)?.[1];
    const rows = txs
      .filter((t) => t.date >= since && t.date <= until)
      .map(wireTx)
      .filter((t) => !acct || t.account_id === acct);
    return json({ data: { transactions: rows } });
  }
  return json({ error: { id: "404", name: `eval fake has no route for ${path}` } }, 404);
};

export interface CallResult {
  text: string;
  structured: Record<string, any>;
  isError: boolean;
}

// One connected client per fixture. Call `install` in beforeEach and
// `uninstall` in afterEach.
export const plan = (txs: FixtureTx[], cats: FixtureCategory[]) => {
  let client: Client;
  return {
    async install() {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
      vi.stubGlobal("fetch", vi.fn(fakeYnab(txs, cats)));
      const [c, s] = InMemoryTransport.createLinkedPair();
      await buildServer({
        ynabUserId: "eval",
        ynabAccessToken: "eval",
        ynabRefreshToken: "eval",
        ynabExpiresAt: Math.floor(Date.now() / 1000) + 7200,
        canWrite: false,
      }).connect(s);
      client = new Client({ name: "eval", version: "0.0.0" });
      await client.connect(c);
      // Caches output schemas, so the client validates structuredContent.
      await client.listTools();
    },
    uninstall() {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
    async tools() {
      return (await client.listTools()).tools;
    },
    async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (e) {
        // The client throws when structuredContent misses its output schema.
        return { text: String(e), structured: {}, isError: true };
      }
      const text = (res.content as { type: string; text?: string }[])
        .map((c) => c.text ?? "")
        .join("\n");
      return { text, structured: (res.structuredContent ?? {}) as Record<string, any>, isError: !!res.isError };
    },
  };
};
