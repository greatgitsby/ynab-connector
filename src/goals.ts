import type { Category } from "./ynab";
import { fmtMoney } from "./format";
import { addMonths, todayIso } from "./month-window";

export interface GoalView {
  type: string;
  label: string;
  targetAmount: number;
  cadenceLabel: string;
  nextDueDate: string | null;
  underfundedThisMonth: number;
  isRecurring: boolean;
  // True when the user snoozed the goal during the reference month
  // (YNAB v1.76 `goal_snoozed_at`). Snoozes apply to a single month.
  snoozed: boolean;
}

// MF (monthly funding) targets are per-month; all other types are total
// targets. Cadence-to-months conversion per YNAB API:
//   1 = monthly (× frequency), 2 = weekly (no monthly equivalent, so the
//   caller falls back to months_to_budget), 3..12 = every (cadence - 1) months,
//   13 = yearly (× frequency, so 12 × freq months), 14 = every 2 years.
const cadenceMonths = (c: Category): number | null => {
  const cadence = c.goal_cadence ?? 0;
  const freq = c.goal_cadence_frequency ?? 1;
  if (cadence === 1) return freq;
  if (cadence === 13) return 12 * freq;
  if (cadence === 14) return 24;
  if (cadence >= 3 && cadence <= 12) return cadence - 1;
  return null;
};

// For recurring goals, YNAB keeps goal_target_date pinned to the original
// anchor (often years in the past) and tracks the next occurrence via
// goal_months_to_budget, the months left in the current goal period
// counting the reference month. Project to the next occurrence and then keep
// adding the cadence interval until the date is strictly in the future (YNAB
// can still report a current-month deadline for a goal that's already met,
// which renders as a past date for any day after the 1st).
//
// GET /plans/{id} sends only the deprecated goal_target_month, so fall back
// to it.
const nextGoalDate = (c: Category, refMonth: string): string | null => {
  const target = c.goal_target_date ?? c.goal_target_month;
  if (!target) return null;
  const recurring = (c.goal_cadence ?? 0) > 0;
  const m2b = c.goal_months_to_budget;
  if (!recurring || m2b == null || m2b < 1) return target;
  const dueIn = (month: string) =>
    `${month.slice(0, 7)}-${target.slice(8, 10)}`;
  let month = addMonths(refMonth, m2b - 1);
  const step = cadenceMonths(c);
  if (step != null && step > 0) {
    const today = todayIso();
    while (dueIn(month) <= today) month = addMonths(month, step);
  }
  return dueIn(month);
};

const buildCadenceLabel = (c: Category): string => {
  if (c.goal_type === "MF") return "/month";
  const cadence = c.goal_cadence ?? 0;
  const freq = c.goal_cadence_frequency ?? 1;
  if (cadence === 1) return freq === 1 ? "/month" : ` every ${freq} months`;
  if (cadence === 2) return freq === 1 ? "/week" : ` every ${freq} weeks`;
  if (cadence === 13) return freq === 1 ? "/year" : ` every ${freq} years`;
  if (cadence === 14) return " every 2 years";
  if (cadence >= 3 && cadence <= 12) return ` every ${cadence - 1} months`;
  return "";
};

export const interpretGoal = (
  c: Category,
  refMonth: string,
  iso = "USD",
): GoalView | null => {
  if (!c.goal_type || c.goal_target == null) return null;
  const cadenceLabel = buildCadenceLabel(c);
  const nextDueDate = nextGoalDate(c, refMonth);
  const underfunded =
    c.goal_under_funded && c.goal_under_funded > 0 ? c.goal_under_funded : 0;
  const snoozed =
    !!c.goal_snoozed_at &&
    c.goal_snoozed_at.slice(0, 7) === refMonth.slice(0, 7);
  const parts = [`${fmtMoney(c.goal_target, iso)}${cadenceLabel}`];
  if (nextDueDate) parts.push(`by ${nextDueDate}`);
  if (underfunded > 0)
    parts.push(`needs ${fmtMoney(underfunded, iso)} more this month`);
  if (snoozed) parts.push("snoozed this month");
  return {
    type: c.goal_type,
    label: parts.join(", "),
    targetAmount: c.goal_target,
    cadenceLabel,
    nextDueDate,
    underfundedThisMonth: underfunded,
    isRecurring: (c.goal_cadence ?? 0) > 0,
    snoozed,
  };
};

export const isUnderfunded = (g: GoalView | null): g is GoalView =>
  g != null && !g.snoozed && g.underfundedThisMonth > 0;

export const fmtGoalSuffix = (
  c: Category,
  refMonth: string,
  iso = "USD",
): string => {
  const view = interpretGoal(c, refMonth, iso);
  return view ? ` — goal: ${view.label}` : "";
};
