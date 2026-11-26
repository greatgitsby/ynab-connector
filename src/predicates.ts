import type { Account, Category, Transaction } from "./ynab";

export const isSpendingCategory = (c: Category): boolean =>
  !c.hidden && !c.deleted && !c.internal;

// YNAB has two internal categories, "Inflow: Ready to Assign" and
// "Uncategorized". Only the name prefix tells them apart.
export const isInflowRta = (c: Category): boolean =>
  !!c.internal && c.name.startsWith("Inflow");

export const isUncategorizedInternal = (c: Category): boolean =>
  !!c.internal && c.name === "Uncategorized";

export const isInboxableTx = (t: Transaction): boolean =>
  t.transfer_account_id == null || !t.approved;

export const isTrackingAccount = (a: Account): boolean => !a.on_budget;

export const isTransferTx = (t: Transaction): boolean =>
  t.transfer_account_id != null;

export const isSplitTx = (t: Transaction): boolean =>
  t.subtransactions?.some((s) => !s.deleted) ?? false;

const fundsEveryMonthOrWeek = (c: Category): boolean => {
  const cadence = c.goal_cadence ?? 0;
  const everyMonth = cadence === 1 && (c.goal_cadence_frequency ?? 1) === 1;
  return everyMonth || cadence === 2;
};

export const isSavingsCategory = (c: Category): boolean =>
  c.goal_type === "TB" ||
  c.goal_type === "TBD" ||
  (c.goal_type === "NEED" && !fundsEveryMonthOrWeek(c));

export const isCardPaymentPayee = (payee: string | null): boolean =>
  /\bcard payment\b|\bpayment,? thank you\b|\bautopay\b|\bepayment\b/i.test(
    payee ?? "",
  );
