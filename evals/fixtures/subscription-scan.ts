export interface FixtureTx {
  id: string;
  date: string;
  amount: number;
  payee: string;
  category: string | null;
  account?: string;
  memo?: string;
  transfer?: boolean;
  parts?: { amount: number; category: string }[];
}

export interface FixtureCategory {
  name: string;
  group: string;
  goal_target?: number;
}

export const CATEGORIES: FixtureCategory[] = [
  { name: "🎉 Fun Money", group: "💳 Discretionary" },
  { name: "Pocket Money", group: "💳 Discretionary" },
  { name: "🏠 Home Care", group: "💳 Fixed Costs", goal_target: 20000 },
  { name: "HBO Max", group: "💳 Monthly Subscriptions" },
  { name: "Google One", group: "💳 Monthly Subscriptions", goal_target: 2990 },
  { name: "Claude", group: "💳 Monthly Subscriptions", goal_target: 100000 },
  { name: "iCloud", group: "💳 Monthly Subscriptions", goal_target: 2990 },
  { name: "🎥 Netflix", group: "💳 Monthly Subscriptions", goal_target: 15490 },
  {
    name: "🎶 Spotify + Hulu",
    group: "💳 Monthly Subscriptions",
    goal_target: 19990,
  },
  {
    name: "🚗 Car App",
    group: "🏦 Annual Subscriptions",
    goal_target: 99000,
  },
  { name: "📰 News", group: "🏦 Annual Subscriptions", goal_target: 60000 },
  {
    name: "🔒 Password Manager",
    group: "🏦 Annual Subscriptions",
    goal_target: 36000,
  },
  {
    name: "📦 Amazon Prime",
    group: "🏦 Annual Subscriptions",
    goal_target: 139000,
  },
];

let n = 0;
const t = (
  date: string,
  amount: number,
  payee: string,
  category: string | null,
  extra: Partial<FixtureTx> = {},
): FixtureTx => ({
  id: `tx-${String(++n).padStart(3, "0")}-${date}`,
  date,
  amount,
  payee,
  category,
  ...extra,
});

export const TRANSACTIONS: FixtureTx[] = [
  t("2026-05-26", -59990, "Virtual Card", "Pocket Money", {
    memo: "Arcade Pass (yearly)",
  }),
  t("2026-10-05", -99000, "Virtual Card", "Pocket Money"),
  t("2026-09-11", -4990, "Virtual Card", "Pocket Money"),
  t("2026-11-09", -12500, "Virtual Card", null),

  t("2026-06-08", -15490, "Virtual Card", "🎥 Netflix"),
  t("2026-06-08", -19990, "Virtual Card", "🎶 Spotify + Hulu"),
  t("2026-07-06", -15490, "Virtual Card", "🎥 Netflix"),
  t("2026-07-07", -19990, "Virtual Card", "🎶 Spotify + Hulu"),
  t("2026-07-13", -99000, "Virtual Card", "Pocket Money", { memo: "Navi" }),
  t("2026-08-06", -15490, "Virtual Card", "🎥 Netflix"),
  t("2026-08-07", -19990, "Virtual Card", "🎶 Spotify + Hulu"),
  t("2026-08-11", -99000, "Virtual Card", "🎉 Fun Money"),
  t("2026-09-01", -4990, "Virtual Card", "Pocket Money"),
  t("2026-09-08", -15490, "Virtual Card", "🎥 Netflix"),
  t("2026-09-08", -19990, "Virtual Card", "🎶 Spotify + Hulu"),
  t("2026-09-30", -8750, "Virtual Card", "🎉 Fun Money"),
  t("2026-10-06", -15490, "Virtual Card", "🎥 Netflix"),
  t("2026-10-07", -19990, "Virtual Card", "🎶 Spotify + Hulu"),
  t("2026-11-03", -2500, "Virtual Card", "Pocket Money"),

  t("2026-06-09", -21600, "Anthropic", "Pocket Money"),
  t("2026-07-02", -20000, "Anthropic", "Pocket Money"),
  t("2026-08-02", -100000, "Anthropic", "Pocket Money"),
  t("2026-09-02", -100000, "Anthropic", "Pocket Money"),
  t("2026-10-02", -100000, "Anthropic Claude", "Pocket Money"),
  t("2026-11-02", -100000, "Anthropic Claude", "Pocket Money"),

  t("2026-06-28", -2990, "Google One", "🎉 Fun Money"),
  t("2026-07-28", -2990, "Google One", "🎉 Fun Money"),
  t("2026-08-28", -2990, "Google One", "🎉 Fun Money"),
  t("2026-09-28", -2990, "Google", "Pocket Money"),
  t("2026-10-28", -2990, "Google One", "🎉 Fun Money"),

  t("2026-05-24", -9990, "Apple", "iCloud"),
  t("2026-06-09", -14990, "Apple", "iCloud"),
  t("2026-06-22", -990, "Apple", "iCloud"),
  t("2026-06-24", -9990, "Apple", "iCloud"),
  t("2026-06-25", -4990, "Apple", "iCloud"),
  t("2026-07-05", -19990, "Apple", "🎉 Fun Money"),
  t("2026-07-05", -1990, "Apple", "Pocket Money"),
  t("2026-07-22", -990, "Apple", "iCloud"),
  t("2026-07-24", -9990, "Apple", "iCloud"),
  t("2026-07-26", -4990, "Apple", "iCloud"),
  t("2026-08-04", -19990, "Apple", "iCloud"),
  t("2026-08-11", -24990, "Apple", "iCloud"),
  t("2026-08-23", -2990, "Apple", "iCloud"),
  t("2026-08-24", -9990, "Apple", "iCloud"),
  t("2026-08-25", -4990, "Apple", "iCloud"),
  t("2026-09-04", -19990, "Apple", "iCloud"),
  t("2026-09-22", -2990, "Apple", "iCloud"),
  t("2026-09-24", -9990, "Apple", "iCloud"),
  t("2026-09-25", -4990, "Apple", "iCloud"),
  t("2026-10-05", -19990, "Apple", "iCloud"),
  t("2026-10-22", -2990, "Apple", "iCloud"),
  t("2026-10-25", -9990, "Apple", "iCloud"),
  t("2026-10-25", -4990, "Apple", "iCloud"),
  t("2026-11-04", -19990, "Apple", "🎉 Fun Money"),
  t("2026-11-06", -14990, "Apple", "🎉 Fun Money"),

  t("2026-05-25", -8990, "Amazon Prime Video Channels", "🎉 Fun Money"),
  t("2026-06-04", -9990, "Amazon Prime Video Channels", "🎉 Fun Money"),
  t("2026-06-25", -8990, "Amazon Prime Video Channels", "🎉 Fun Money"),
  t("2026-07-05", -9990, "Amazon Prime Video Channels", "🎉 Fun Money"),
  t("2026-07-26", -8990, "Amazon Prime Video Channels", "HBO Max", {
    memo: "Amzn",
  }),
  t("2026-08-04", -9990, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-08-25", -8990, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-09-06", -9990, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-09-27", -8990, "Amazon Prime Video Channels", "🎉 Fun Money"),
  t("2026-10-05", -11990, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-10-25", -8990, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-10-29", -6990, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-11-04", -11990, "Amazon Prime Video Channels", "HBO Max"),

  t("2026-06-01", -10000, "Apple Card Payment", "🎉 Fun Money", {
    account: "Checking",
  }),
  t("2026-07-01", -8000, "Apple Card Payment", "🎉 Fun Money", {
    account: "Checking",
  }),
  t("2026-08-01", -5000, "Apple Card Payment", "🎉 Fun Money", {
    account: "Checking",
  }),
  t("2026-09-01", -4500, "Apple Card Payment", "🎉 Fun Money", {
    account: "Checking",
  }),
  t("2026-10-01", -6000, "Apple Card Payment", "🎉 Fun Money", {
    account: "Checking",
  }),
  t("2026-10-13", -50000, "Apple Card Payment", "🎉 Fun Money", {
    account: "Checking",
  }),
  t("2026-10-26", -750000, "Apple Card Payment", "🎉 Fun Money", {
    account: "Checking",
  }),
  t("2026-10-15", -250000, "Transfer : Savings", null, {
    account: "Checking",
    transfer: true,
  }),
];
