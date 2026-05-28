import type { Category, Transaction } from "./ynab";

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

// True when a Transaction is a transfer between two accounts in the same
// budget. Transfers are excluded from spending stats — moving money between
// accounts isn't spending even though one side is negative.
export const isTransferTx = (t: Transaction): boolean =>
  t.transfer_account_id != null;
