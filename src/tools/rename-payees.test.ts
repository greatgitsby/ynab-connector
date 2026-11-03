import { describe, test, expect, vi } from "vitest";
import { YnabError, type Payee, type YnabClient } from "../ynab";
import { applyRenamePayees, renameRefusal, renderRenamePayeesResult } from "./rename-payees";

const p = (id: string, name: string, over: Partial<Payee> = {}): Payee => ({
  id,
  name,
  transfer_account_id: null,
  deleted: false,
  ...over,
});

const payees = [
  p("a", "AMZN Mktp"),
  p("b", "Amazon"),
  p("x", "Transfer : Savings", { transfer_account_id: "acc-2" }),
  p("d", "Old Name", { deleted: true }),
];

describe("renameRefusal", () => {
  test("refuses unknown, deleted, and transfer payees", () => {
    expect(renameRefusal({ payee_id: "zz", name: "N" }, payees)).toMatch(/No such payee/);
    expect(renameRefusal({ payee_id: "d", name: "N" }, payees)).toMatch(/No such payee/);
    expect(renameRefusal({ payee_id: "x", name: "N" }, payees)).toMatch(/rename the account/);
  });

  test("refuses another live payee's name, ignoring case, and points to merge_payees", () => {
    expect(renameRefusal({ payee_id: "a", name: " amazon " }, payees)).toMatch(/merge_payees/);
    // A deleted payee's name is free, and so is a case change of one's own name.
    expect(renameRefusal({ payee_id: "a", name: "Old Name" }, payees)).toBeNull();
    expect(renameRefusal({ payee_id: "b", name: "AMAZON" }, payees)).toBeNull();
  });
});

describe("applyRenamePayees", () => {
  const client = () => {
    const updatePayee = vi.fn(async (_plan: string, id: string, body: { name: string }) => {
      if (id === "b") throw new YnabError(400, "bad");
      return { data: { payee: p(id, body.name) } };
    });
    return {
      updatePayee,
      c: {
        listPayees: async () => ({ data: { payees } }),
        updatePayee,
      } as unknown as YnabClient,
    };
  };

  test("sends { name }, reports before/after, and keeps going after a failure", async () => {
    const { c, updatePayee } = client();
    const out = await applyRenamePayees(c, "plan", [
      { payee_id: "b", name: "Amazon.com" },
      { payee_id: "a", name: "Amazon Marketplace" },
    ]);
    expect(updatePayee).toHaveBeenCalledWith("plan", "a", { name: "Amazon Marketplace" });
    expect(out.results).toEqual([
      { ok: false, payee_id: "b", error: "YNAB 400: bad" },
      { ok: true, payee_id: "a", before_name: "AMZN Mktp", after_name: "Amazon Marketplace" },
    ]);
    expect(renderRenamePayeesResult(out)).toContain('"AMZN Mktp" → "Amazon Marketplace"');
  });

  test("a later rename in the batch sees an earlier one's new name", async () => {
    const { c, updatePayee } = client();
    const out = await applyRenamePayees(c, "plan", [
      { payee_id: "a", name: "Shop" },
      { payee_id: "b", name: "shop" },
    ]);
    expect(out.results[1]).toMatchObject({ ok: false, error: expect.stringMatching(/merge_payees/) });
    expect(updatePayee).toHaveBeenCalledTimes(1);
  });
});
