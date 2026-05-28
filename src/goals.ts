import type { Category } from "./ynab";
import { fmtMoney } from "./format";

// Interpreted form of a YNAB Goal. Hides the goal_* matrix from callers.
// Returned by interpretGoal(); null when the Category carries no goal.
export interface GoalView {
  // Pre-formatted suffix as used in category line rendering, e.g.
  //   "$500/month, by 2026-08-01, needs $200 more this month"
  label: string;
  // Raw target in milliunits — for callers that build their own line.
  targetAmount: number;
  // Cadence suffix, e.g. "/month", "/week", " every 3 months", or "" for one-shot goals.
  cadenceLabel: string;
  // Next due date as YYYY-MM-DD, or null when the goal has no date.
  nextDueDate: string | null;
  // Milliunits still needed this month to stay on pace. 0 when fully funded.
  underfundedThisMonth: number;
  // True for any cadence > 0; false for single-target goals.
  isRecurring: boolean;
}

// MF (monthly funding) targets are per-month; all other types are total
// targets. Cadence-to-months conversion per YNAB API:
//   1 = monthly (× frequency), 2 = weekly (no monthly equivalent — caller
//   falls back to months_to_budget), 3..12 = every (cadence - 1) months,
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

const addMonths = (year: number, month1: number, delta: number) => {
  const t = new Date(Date.UTC(year, month1 - 1 + delta, 1));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1] as const;
};

// For recurring goals, YNAB keeps goal_target_date pinned to the original
// anchor (often years in the past) and tracks the next occurrence via
// goal_months_to_budget — months remaining in the current goal period,
// counting the reference month. Project to the next occurrence and then keep
// adding the cadence interval until the date is strictly in the future (YNAB
// can still report a current-month deadline for a goal that's already met,
// which renders as a past date for any day after the 1st).
const nextGoalDate = (c: Category, refMonth: string): string | null => {
  if (!c.goal_target_date) return null;
  const recurring = (c.goal_cadence ?? 0) > 0;
  const m2b = c.goal_months_to_budget;
  if (!recurring || m2b == null || m2b < 1) return c.goal_target_date;
  const [refY, refM] = refMonth.split("-").map(Number);
  const anchorDay = c.goal_target_date.slice(8, 10);
  let [y, mo] = addMonths(refY, refM, m2b - 1);
  const step = cadenceMonths(c);
  if (step != null && step > 0) {
    const today = new Date();
    const todayIso = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    while (
      `${y}-${String(mo).padStart(2, "0")}-${anchorDay}` <= todayIso
    ) {
      [y, mo] = addMonths(y, mo, step);
    }
  }
  return `${y}-${String(mo).padStart(2, "0")}-${anchorDay}`;
};

// Human-readable cadence label so `$67` doesn't get misread as a monthly
// target when it's actually weekly. Cadence codes per YNAB API:
//   0 = single goal (no cadence); 1 = monthly × freq; 2 = weekly × freq;
//   3..12 = every (cadence - 1) months; 13 = yearly × freq; 14 = every 2 years.
// MF goals always represent a monthly funding amount regardless of cadence.
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
): GoalView | null => {
  if (!c.goal_type || c.goal_target == null) return null;
  const cadenceLabel = buildCadenceLabel(c);
  const nextDueDate = nextGoalDate(c, refMonth);
  const underfunded =
    c.goal_under_funded && c.goal_under_funded > 0 ? c.goal_under_funded : 0;
  const parts = [`${fmtMoney(c.goal_target)}${cadenceLabel}`];
  if (nextDueDate) parts.push(`by ${nextDueDate}`);
  if (underfunded > 0)
    parts.push(`needs ${fmtMoney(underfunded)} more this month`);
  return {
    label: parts.join(", "),
    targetAmount: c.goal_target,
    cadenceLabel,
    nextDueDate,
    underfundedThisMonth: underfunded,
    isRecurring: (c.goal_cadence ?? 0) > 0,
  };
};

// Convenience for category-line rendering — same shape as the old fmtGoal.
export const fmtGoalSuffix = (c: Category, refMonth: string): string => {
  const view = interpretGoal(c, refMonth);
  return view ? ` — goal: ${view.label}` : "";
};
