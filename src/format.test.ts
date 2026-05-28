import { describe, test, expect } from "vitest";
import { YnabError, type Category, type Transaction } from "./ynab";
import {
  text,
  handleError,
  fmtMoney,
  padMoney,
  fmtPercent,
  pushSection,
  fmtCategoryLine,
  fmtTxLine,
  fmtActivityLine,
  result,
  scopeDeniedError,
} from "./format";

describe("text", () => {
  test("wraps a string in the MCP content shape", () => {
    expect(text("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });
});

describe("result", () => {
  test("attaches structuredContent alongside the text block", () => {
    const out = result("ok", { count: 3, ids: ["a", "b", "c"] });
    expect(out).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { count: 3, ids: ["a", "b", "c"] },
    });
  });
});

describe("scopeDeniedError", () => {
  test("returns isError: true with a reconnect-style message", () => {
    const out = scopeDeniedError();
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/read-only/i);
    expect(out.content[0].text).toMatch(/reconnect/i);
  });
});

describe("handleError", () => {
  test("formats YnabError with status and body", () => {
    const result = handleError(new YnabError(404, "Not found"));
    expect(result.content[0].text).toBe("YNAB error 404: Not found");
  });

  test("formats generic Error with its message", () => {
    const result = handleError(new Error("oops"));
    expect(result.content[0].text).toBe("Error: oops");
  });

  test("stringifies non-Error throws", () => {
    expect(handleError("just a string").content[0].text).toBe(
      "Error: just a string",
    );
    expect(handleError(42).content[0].text).toBe("Error: 42");
  });
});

describe("fmtMoney", () => {
  test("converts milliunits to USD by default", () => {
    expect(fmtMoney(1_234_560)).toBe("$1,234.56");
  });

  test("renders negatives", () => {
    expect(fmtMoney(-50_000)).toBe("-$50.00");
  });

  test("renders zero", () => {
    expect(fmtMoney(0)).toBe("$0.00");
  });

  test("honours a non-USD ISO code", () => {
    expect(fmtMoney(1_000_000, "EUR")).toBe("€1,000.00");
  });
});

describe("padMoney", () => {
  test("right-pads to the requested width", () => {
    expect(padMoney(1_000, 10)).toBe("     $1.00");
  });

  test("does not truncate if the number is wider than the column", () => {
    const out = padMoney(123_456_789, 4);
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.trimStart()).toBe("$123,456.79");
  });
});

describe("fmtPercent", () => {
  test("returns 0.0% when total is zero", () => {
    expect(fmtPercent(50, 0)).toBe("0.0%");
  });

  test("computes one decimal place", () => {
    expect(fmtPercent(33, 100)).toBe("33.0%");
    expect(fmtPercent(1, 3)).toBe("33.3%");
  });

  test("handles 100%", () => {
    expect(fmtPercent(7, 7)).toBe("100.0%");
  });
});

const cat = (overrides: Partial<Category>): Category => ({
  id: "cat-1",
  category_group_id: "grp-1",
  name: "Groceries",
  hidden: false,
  budgeted: 500_000,
  activity: -350_000,
  balance: 150_000,
  ...overrides,
});

const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: "tx-1",
  date: "2026-05-01",
  amount: -50_000,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "acc-1",
  account_name: "Checking",
  payee_id: null,
  payee_name: "Costco",
  category_id: "cat-1",
  category_name: "Groceries",
  flag_color: null,
  transfer_account_id: null,
  ...overrides,
});

describe("fmtCategoryLine", () => {
  test("renders budgeted, activity, and balance", () => {
    const line = fmtCategoryLine(cat({}), "2026-05-01");
    expect(line).toBe(
      "- Groceries: budgeted $500.00, activity -$350.00, balance $150.00",
    );
  });

  test("appends goal suffix when category has a goal", () => {
    const line = fmtCategoryLine(
      cat({ goal_type: "MF", goal_target: 500_000 }),
      "2026-05-01",
    );
    expect(line).toContain(" — goal: $500.00/month");
  });

  test("appends id when includeIds is true", () => {
    const line = fmtCategoryLine(cat({}), "2026-05-01", true);
    expect(line).toContain("— id cat-1");
  });
});

describe("fmtTxLine", () => {
  test("renders date, amount, payee, category, and account", () => {
    const line = fmtTxLine(tx({}));
    expect(line).toBe(
      "- 2026-05-01 -$50.00 Costco → Groceries [Checking]",
    );
  });

  test("falls back to (no payee) and (uncategorized) when missing", () => {
    const line = fmtTxLine(
      tx({ payee_name: null, category_name: null }),
    );
    expect(line).toContain("(no payee)");
    expect(line).toContain("(uncategorized)");
  });

  test("hides category when showCategory is false", () => {
    const line = fmtTxLine(tx({}), { showCategory: false });
    expect(line).not.toContain("→");
  });

  test("appends (unapproved) when not approved", () => {
    expect(fmtTxLine(tx({ approved: false }))).toContain("(unapproved)");
  });

  test("appends id when includeIds is true", () => {
    expect(fmtTxLine(tx({}), { includeIds: true })).toContain("— id tx-1");
  });
});

describe("fmtActivityLine", () => {
  test("renders parent transaction activity", () => {
    const line = fmtActivityLine({
      date: "2026-05-01",
      amount: -75_000,
      payee_name: "Whole Foods",
      account_name: "Visa",
      approved: true,
      parent_id: "parent-1",
    });
    expect(line).toBe("- 2026-05-01 -$75.00 Whole Foods [Visa]");
  });

  test("appends note when present", () => {
    const line = fmtActivityLine({
      date: "2026-05-01",
      amount: -10_000,
      payee_name: "Costco",
      account_name: "Visa",
      approved: true,
      parent_id: "parent-1",
      sub_id: "sub-1",
      note: 'split from "Costco"',
    });
    expect(line).toContain('(split from "Costco")');
  });

  test("uses sub_id for the id suffix when present", () => {
    const line = fmtActivityLine(
      {
        date: "2026-05-01",
        amount: -10_000,
        payee_name: "X",
        account_name: "Y",
        approved: true,
        parent_id: "parent-1",
        sub_id: "sub-9",
      },
      true,
    );
    expect(line).toContain("— id sub-9");
  });
});

describe("pushSection", () => {
  const render = (n: number) => `- ${n}`;

  test("renders (none) on empty input", () => {
    const out: string[] = [];
    pushSection(out, "Things", [], 5, render);
    expect(out).toEqual(["## Things (0)", "(none)", ""]);
  });

  test("shows total when under the cap", () => {
    const out: string[] = [];
    pushSection(out, "Things", [1, 2, 3], 10, render);
    expect(out).toEqual(["## Things (3)", "- 1", "- 2", "- 3", ""]);
  });

  test("annotates the header when over the cap", () => {
    const out: string[] = [];
    pushSection(out, "Things", [1, 2, 3, 4, 5], 2, render);
    expect(out[0]).toBe("## Things (showing 2 of 5)");
    expect(out.slice(1, 3)).toEqual(["- 1", "- 2"]);
    expect(out.at(-1)).toBe("");
  });
});
