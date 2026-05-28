import type { BudgetDetail, MonthDetail } from "./ynab";

// Resolved window of months a Reflect tool operates over. Folds together the
// "requested vs available" intersection and the truncation note that every
// multi-month tool would otherwise compute and format itself.
export interface MonthWindow {
  // Months requested by monthsBack, ending at the current calendar month,
  // clamped to >= budget.first_month. Chronological (oldest first).
  requested: string[];
  // Subset of `requested` for which the Budget has a MonthDetail.
  present: string[];
  // MonthDetail objects parallel to `present`.
  months: MonthDetail[];
  // Indexed view of every MonthDetail in the Budget. Convenient for direct
  // lookups (e.g. age_of_money pulls the latest month).
  monthsByKey: Map<string, MonthDetail>;
  // Pre-formatted truncation message, or null when no truncation occurred.
  // Example: "(Budget starts 2025-09-01; window truncated to 4 of 6 requested months.)"
  truncationNote: string | null;
}

const addMonths = (year: number, month1: number, delta: number) => {
  const t = new Date(Date.UTC(year, month1 - 1 + delta, 1));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1] as const;
};

// Builds an array of YYYY-MM-01 strings ending at the current calendar month,
// length monthsBack, clamped to >= firstMonth. End is the current month (not
// +1) because YNAB returns the current month with zeroed activity for
// forward-looking budget rows we don't want to render.
const windowMonths = (monthsBack: number, firstMonth: string): string[] => {
  const today = new Date();
  const endY = today.getUTCFullYear();
  const endM = today.getUTCMonth() + 1;
  const out: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const [y, m] = addMonths(endY, endM, -i);
    const iso = `${y}-${String(m).padStart(2, "0")}-01`;
    if (iso < firstMonth) continue;
    out.push(iso);
  }
  return out;
};

export const resolveMonthWindow = (
  budget: BudgetDetail,
  monthsBack: number,
): MonthWindow => {
  const allMonths = budget.months ?? [];
  const monthsByKey = new Map(allMonths.map((m) => [m.month, m]));
  const requested = windowMonths(monthsBack, budget.first_month);
  const present = requested.filter((k) => monthsByKey.has(k));
  const months = present.map((k) => monthsByKey.get(k)!);
  const truncationNote =
    present.length < monthsBack
      ? `(Budget starts ${budget.first_month}; window truncated to ${present.length} of ${monthsBack} requested months.)`
      : null;
  return { requested, present, months, monthsByKey, truncationNote };
};

// Last day of a YYYY-MM-01 month as YYYY-MM-DD. JS Date day=0 of month m+1
// resolves to the last day of month m.
export const monthEndDate = (monthKey: string): string => {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

export const daysInMonth = (monthKey: string): number => {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

// Resolve a month spec to a concrete YYYY-MM-01 key. Accepts "current",
// "last_month", or a literal YYYY-MM-01.
export const resolveMonthSpec = (spec: string): string => {
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  if (spec === "current") return `${y}-${String(m).padStart(2, "0")}-01`;
  if (spec === "last_month") {
    const [py, pm] = addMonths(y, m, -1);
    return `${py}-${String(pm).padStart(2, "0")}-01`;
  }
  return spec;
};
