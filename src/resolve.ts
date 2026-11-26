import type { Account, CategoryGroup, Payee } from "./ynab";

// Name-or-id lookup for categories, payees, and accounts, so callers can say
// "Groceries" instead of fetching a list to find its uuid.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s.trim());

// Case, emoji, punctuation, and stored HTML escapes ("Bread &amp; Butter") are
// ignored, so "netflix" matches "🎥 Netflix".
export const normalizeName = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .trim()
    .toLowerCase();

export interface Named {
  id: string;
  name: string;
  // Category group name, so "Group: Name" can pick between same-named
  // categories.
  group?: string;
  // Hidden or closed. Used only to break ties toward the live one.
  inactive?: boolean;
}

export type Resolution<T> =
  { ok: true; matches: T[] } | { ok: false; error: string };

const label = (x: Named) => (x.group ? `${x.group}: ${x.name}` : x.name);

// Every candidate a reference could mean: the id itself, an exact
// (normalized) name, "Group: Name", and only then names containing it.
const candidates = <T extends Named>(items: T[], ref: string): T[] => {
  const byId = items.filter((x) => x.id === ref.trim());
  if (byId.length) return byId;
  const want = normalizeName(ref);
  if (!want) return [];
  const exact = items.filter((x) => normalizeName(x.name) === want);
  if (exact.length) return exact;
  const grouped = items.filter(
    (x) => x.group && normalizeName(`${x.group} ${x.name}`) === want,
  );
  if (grouped.length) return grouped;
  return items.filter((x) => normalizeName(x.name).includes(want));
};

const notFound = (kind: string, ref: string) => `No ${kind} matches "${ref}".`;

// For filters: every match counts, so "Apple" covers two payees named Apple.
export const resolveAll = <T extends Named>(
  items: T[],
  ref: string,
  kind: string,
): Resolution<T> => {
  const found = candidates(items, ref);
  return found.length
    ? { ok: true, matches: found }
    : { ok: false, error: notFound(kind, ref) };
};

// For writes: exactly one, or an error naming the choices. A live match wins
// over hidden or closed ones of the same name.
export const resolveOne = <T extends Named>(
  items: T[],
  ref: string,
  kind: string,
): Resolution<T> => {
  const found = candidates(items, ref);
  if (!found.length) return { ok: false, error: notFound(kind, ref) };
  const live = found.filter((x) => !x.inactive);
  const pick = live.length ? live : found;
  if (pick.length === 1) return { ok: true, matches: pick };
  const shown = pick
    .slice(0, 8)
    .map((x) => `"${label(x)}" (${x.id})`)
    .join(", ");
  return {
    ok: false,
    error: `"${ref}" matches ${pick.length} ${kind === "category" ? "categories" : `${kind}s`}: ${shown}. Use an id${kind === "category" ? ' or "Group: Name"' : ""}.`,
  };
};

export const categoryRefs = (groups: CategoryGroup[]): Named[] =>
  groups
    .filter((g) => !g.deleted)
    .flatMap((g) =>
      (g.categories ?? [])
        .filter((c) => !c.deleted)
        .map((c) => ({
          id: c.id,
          name: c.name,
          group: g.name,
          inactive: c.hidden || g.hidden,
        })),
    );

export const payeeRefs = (payees: Payee[]): Named[] =>
  payees.filter((p) => !p.deleted).map((p) => ({ id: p.id, name: p.name }));

export const accountRefs = (accounts: Account[]): Named[] =>
  accounts
    .filter((a) => !a.deleted)
    .map((a) => ({ id: a.id, name: a.name, inactive: a.closed }));
