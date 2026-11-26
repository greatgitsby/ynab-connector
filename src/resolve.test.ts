import { describe, expect, test } from "bun:test";
import { normalizeName, resolveAll, resolveOne, type Named } from "./resolve";

const items: Named[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    name: "🎥 Netflix",
    group: "Subscriptions",
  },
  { id: "c-dine-1", name: "Dining", group: "Fun" },
  { id: "c-dine-2", name: "Dining", group: "Travel" },
  { id: "c-old", name: "Gym", group: "Health", inactive: true },
  { id: "c-gym", name: "Gym", group: "Health" },
  { id: "p-amp", name: "Bread &amp; Butter" },
  { id: "c-spot", name: "Spotify + Hulu" },
];

describe("normalizeName", () => {
  test("ignores case, emoji, punctuation, and stored &amp;", () => {
    expect(normalizeName("🎥  Netflix!")).toBe("netflix");
    expect(normalizeName("Bread &amp; Butter")).toBe(
      normalizeName("bread & butter"),
    );
  });
});

describe("resolveOne", () => {
  test("matches an id, an exact name, Group: Name, then a unique substring", () => {
    const one = (ref: string) => {
      const r = resolveOne(items, ref, "category");
      return r.ok ? r.matches.map((m) => m.id) : r.error;
    };
    expect(one("11111111-1111-1111-1111-111111111111")).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
    expect(one("netflix")).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(one("Travel: Dining")).toEqual(["c-dine-2"]);
    expect(one("spotify")).toEqual(["c-spot"]);
    expect(one("bread & butter")).toEqual(["p-amp"]);
  });

  test("prefers the live one of same-named matches, else refuses", () => {
    expect(resolveOne(items, "gym", "category")).toEqual({
      ok: true,
      matches: [items[4]],
    });
    const r = resolveOne(items, "Dining", "category");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('"Fun: Dining" (c-dine-1)');
  });

  test("an exact name wins over longer names containing it", () => {
    const r = resolveOne(
      [...items, { id: "c-dine-out", name: "Dining Out" }],
      "Fun: Dining",
      "category",
    );
    expect(r).toEqual({ ok: true, matches: [items[1]] });
  });
});

describe("resolveAll", () => {
  test("keeps every match, and reports a miss", () => {
    const r = resolveAll(items, "dining", "category");
    expect(r.ok && r.matches.map((m) => m.id)).toEqual([
      "c-dine-1",
      "c-dine-2",
    ]);
    expect(resolveAll(items, "nope", "payee")).toEqual({
      ok: false,
      error: 'No payee matches "nope".',
    });
  });
});
