import { describe, test, expect } from "vitest";
import type { Account } from "../ynab";
import {
  computeAccountList,
  renderAccountList,
} from "./list-accounts";

const account = (overrides: Partial<Account>): Account => ({
  id: "acc-x",
  name: "Account",
  type: "checking",
  on_budget: true,
  closed: false,
  balance: 1_000_000,
  cleared_balance: 950_000,
  uncleared_balance: 50_000,
  ...overrides,
});

describe("computeAccountList", () => {
  test("hides closed accounts by default", () => {
    const r = computeAccountList(
      [
        account({ id: "open" }),
        account({ id: "closed", closed: true }),
      ],
      { includeClosed: false },
    );
    expect(r.accounts.map((a) => a.id)).toEqual(["open"]);
  });

  test("keeps closed accounts when includeClosed is true", () => {
    const r = computeAccountList(
      [account({ id: "open" }), account({ id: "closed", closed: true })],
      { includeClosed: true },
    );
    expect(r.accounts).toHaveLength(2);
  });
});

describe("renderAccountList", () => {
  test("'No accounts.' on empty", () => {
    expect(
      renderAccountList({ accounts: [] }, { includeIds: false }),
    ).toBe("No accounts.");
  });

  test("emits one line per account with type, budget tag, and balance", () => {
    const r = computeAccountList(
      [
        account({ id: "checking", name: "Checking" }),
        account({
          id: "tracking",
          name: "Brokerage",
          type: "otherAsset",
          on_budget: false,
        }),
      ],
      { includeClosed: false },
    );
    const out = renderAccountList(r, { includeIds: true });
    expect(out).toContain("- Checking [checking] (on-budget): balance $1,000.00");
    expect(out).toContain("- Brokerage [otherAsset] (off-budget)");
    expect(out).toContain("— id checking");
  });
});
