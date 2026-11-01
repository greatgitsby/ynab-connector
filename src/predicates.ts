import type { Account, Category, Transaction } from "./ynab";

// True when a Category counts as a real spending bucket: visible, not deleted,
// and not one of YNAB's synthetic `internal` categories (Inflow: Ready to
// Assign, Uncategorized). Use everywhere a Reflect-style view aggregates over
// "real" categories.
export const isSpendingCategory = (c: Category): boolean =>
  !c.hidden && !c.deleted && !c.internal;

// True for YNAB's synthetic "Inflow: Ready to Assign" category — internal, and
// its name starts with "Inflow". The other internal category is "Uncategorized"
// so the name prefix is what distinguishes them.
export const isInflowRta = (c: Category): boolean =>
  !!c.internal && c.name.startsWith("Inflow");

// True for YNAB's synthetic "Uncategorized" aggregate category — internal with
// the literal name "Uncategorized". YNAB's UI hoists this above the grouped
// expense rows; treat it as a stand-alone row in compute output.
export const isUncategorizedInternal = (c: Category): boolean =>
  !!c.internal && c.name === "Uncategorized";

// True when a Transaction belongs in the triage inbox: either it's not a
// transfer between on-budget accounts, or it is a transfer but the user
// hasn't approved it yet. Approved transfers have no category by design and
// shouldn't surface in inbox review.
export const isInboxableTx = (t: Transaction): boolean =>
  t.transfer_account_id == null || !t.approved;

// True for an off-budget (tracking) Account, such as a brokerage, 401(k), or
// mortgage. Its transactions never take a category and don't count as
// spending, so a missing category there is never something to fix.
export const isTrackingAccount = (a: Account): boolean => !a.on_budget;

// True when a Transaction is a transfer between two accounts in the same
// plan. Transfers are excluded from spending stats — moving money between
// accounts isn't spending even though one side is negative.
export const isTransferTx = (t: Transaction): boolean =>
  t.transfer_account_id != null;

// True when a Category's goal saves toward something bigger than this
// month's spending: a target balance (TB, TBD) or a Plan Your Spending (NEED)
// goal that isn't due every week or every month. Money moved out of one of
// these to cover other spending is drawing down savings.
export const isSavingsCategory = (c: Category): boolean => {
  if (c.goal_type === "TB" || c.goal_type === "TBD") return true;
  if (c.goal_type !== "NEED") return false;
  const cadence = c.goal_cadence ?? 0;
  const everyMonth = cadence === 1 && (c.goal_cadence_frequency ?? 1) === 1;
  return !(everyMonth || cadence === 2);
};
