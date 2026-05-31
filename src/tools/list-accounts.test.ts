import { describe, test, expect } from "vitest";
import type { Account } from "../ynab";
import {
  computeAccountList,
  renderAccountList,
  AccountListSchema,
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

  test("result conforms to AccountListSchema", () => {
    const r = computeAccountList(
      [
        account({ id: "open" }),
        account({
          id: "linked",
          direct_import_linked: true,
          last_reconciled_at: "2026-04-30T12:00:00+00:00",
        }),
      ],
      { includeClosed: false, iso: "USD" },
    );
    expect(() => AccountListSchema.parse(r)).not.toThrow();
  });
});

describe("renderAccountList", () => {
  test("'No accounts.' on empty", () => {
    expect(
      renderAccountList({ iso: "USD", accounts: [] }, { includeIds: false }),
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

  test("surfaces link health and last-reconciled date when present", () => {
    const r = computeAccountList(
      [
        account({
          id: "linked",
          name: "Checking",
          direct_import_linked: true,
          last_reconciled_at: "2026-04-30T12:00:00+00:00",
        }),
        account({
          id: "broken",
          name: "Savings",
          direct_import_linked: true,
          direct_import_in_error: true,
        }),
      ],
      { includeClosed: false },
    );
    const out = renderAccountList(r, { includeIds: false });
    expect(out).toContain("linked ✓, last reconciled 2026-04-30");
    expect(out).toContain("linked ⚠ (connection error)");
  });

  test("omits link info for unlinked accounts", () => {
    const r = computeAccountList([account({ name: "Cash" })], {
      includeClosed: false,
    });
    const out = renderAccountList(r, { includeIds: false });
    expect(out).not.toContain("linked");
    expect(out).not.toContain("last reconciled");
  });
});
