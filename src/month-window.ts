import type { MonthDetail } from "./ynab";

const pad = (n: number) => String(n).padStart(2, "0");

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;

// Shift a YYYY-MM-01 key by `delta` months.
export const addMonths = (key: string, delta: number): string => {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(Date.UTC(y, m - 1 + delta, 1)));
};

// Resolve YNAB's month spec ("current" or YYYY-MM-01) to a concrete key.
// "current" is the current calendar month in UTC, as YNAB defines it.
export const resolveMonth = (spec: string): string =>
  spec === "current" ? monthKey(new Date()) : spec;

// Resolve a tool's since_month / until_month inputs. Without since_month the
// range is the `defaultMonths` months ending at until_month.
export const resolveMonthRange = (
  sinceMonth: string | undefined,
  untilMonth: string,
  defaultMonths: number,
): { since: string; until: string } => {
  const until = resolveMonth(untilMonth);
  const since = sinceMonth
    ? resolveMonth(sinceMonth)
    : addMonths(until, -(defaultMonths - 1));
  return { since, until };
};

// Every YYYY-MM-01 key from `since` through `until`, inclusive.
export const monthsBetween = (since: string, until: string): string[] => {
  const out: string[] = [];
  for (let k = since; k <= until; k = addMonths(k, 1)) out.push(k);
  return out;
};

// The months a multi-month tool covers: the requested range intersected with
// the months the Plan has data for.
export interface MonthWindow {
  // Chronological.
  requested: string[];
  // Subset of `requested` the Plan has a MonthDetail for.
  present: string[];
  // MonthDetail objects parallel to `present`.
  months: MonthDetail[];
  truncation_note: string | null;
}

export const resolveMonthWindow = (
  planMonths: MonthDetail[],
  since: string,
  until: string,
): MonthWindow => {
  const byKey = new Map(planMonths.map((m) => [m.month, m]));
  const requested = monthsBetween(since, until);
  const present = requested.filter((k) => byKey.has(k));
  const truncation_note =
    present.length < requested.length
      ? `(The Plan has data for ${present.length} of ${requested.length} requested months.)`
      : null;
  return {
    requested,
    present,
    months: present.map((k) => byKey.get(k)!),
    truncation_note,
  };
};

// Last day of a YYYY-MM-01 month as YYYY-MM-DD.
export const monthEndDate = (key: string): string => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
