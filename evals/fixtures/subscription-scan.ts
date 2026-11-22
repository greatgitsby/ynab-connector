// A slice of a real plan, read on 2026-11-22 for the subscription-scan rerun
// (2026-05-22 to 2026-11-22). Ids are synthetic; dates, amounts, payees,
// categories, memos, and goal targets are as read.

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
  { name: "🎉 NFFF", group: "💳 Discretionary" },
  { name: "Trey Comma", group: "💳 Discretionary" },
  { name: "🏠 Home Care", group: "💳 Fixed Costs", goal_target: 25000 },
  { name: "HBO Max", group: "💳 Monthly Subscriptions" },
  { name: "Google One", group: "💳 Monthly Subscriptions", goal_target: 1990 },
  { name: "Claude", group: "💳 Monthly Subscriptions", goal_target: 218400 },
  { name: "iCloud", group: "💳 Monthly Subscriptions", goal_target: 15990 },
  { name: "🎥 Netflix", group: "💳 Monthly Subscriptions", goal_target: 9820 },
  { name: "🎶 Spotify + HULU", group: "💳 Monthly Subscriptions", goal_target: 14190 },
  { name: "Tesla Premium Connectivity", group: "🏦 Annual Subscriptions", goal_target: 108110 },
  { name: "📧 Fastmail", group: "🏦 Annual Subscriptions", goal_target: 50000 },
  { name: "🔒 1password", group: "🏦 Annual Subscriptions", goal_target: 36000 },
  { name: "📦 Amazon Prime", group: "🏦 Annual Subscriptions", goal_target: 151790 },
];

let n = 0;
const t = (
  date: string,
  amount: number,
  payee: string,
  category: string | null,
  extra: Partial<FixtureTx> = {},
): FixtureTx => ({ id: `tx-${String(++n).padStart(3, "0")}-${date}`, date, amount, payee, category, ...extra });

export const TRANSACTIONS: FixtureTx[] = [
  t("2026-05-26", -99990, "Privacy.com", "Trey Comma", { memo: "Discord Nitro (yearly)" }),
  t("2026-10-05", -108110, "Privacy.com", "Trey Comma"),
  t("2026-09-11", -3990, "Privacy.com", "Trey Comma"),
  t("2026-11-09", -24010, "Privacy.com", null),

  // Privacy.com cards.
  t("2026-06-08", -9820, "Privacy.com", "🎥 Netflix"),
  t("2026-06-08", -14190, "Privacy.com", "🎶 Spotify + HULU"),
  t("2026-07-06", -9820, "Privacy.com", "🎥 Netflix"),
  t("2026-07-07", -14190, "Privacy.com", "🎶 Spotify + HULU"),
  t("2026-07-13", -108110, "Privacy.com", "Trey Comma", { memo: "Fsd" }),
  t("2026-08-06", -9820, "Privacy.com", "🎥 Netflix"),
  t("2026-08-07", -14190, "Privacy.com", "🎶 Spotify + HULU"),
  t("2026-08-11", -108110, "Privacy.com", "🎉 NFFF"),
  t("2026-09-01", -3990, "Privacy.com", "Trey Comma"),
  t("2026-09-08", -9820, "Privacy.com", "🎥 Netflix"),
  t("2026-09-08", -14190, "Privacy.com", "🎶 Spotify + HULU"),
  t("2026-09-30", -13180, "Privacy.com", "🎉 NFFF"),
  t("2026-10-06", -9820, "Privacy.com", "🎥 Netflix"),
  t("2026-10-07", -14190, "Privacy.com", "🎶 Spotify + HULU"),
  t("2026-11-03", -3230, "Privacy.com", "Trey Comma"),

  // Anthropic, renamed to "Anthropic Claude" after 9/2.
  t("2026-06-09", -109200, "Anthropic", "Trey Comma"),
  t("2026-07-02", -194140, "Anthropic", "Trey Comma"),
  t("2026-08-02", -218400, "Anthropic", "Trey Comma"),
  t("2026-09-02", -218400, "Anthropic", "Trey Comma"),
  t("2026-10-02", -218400, "Anthropic Claude", "Trey Comma"),
  t("2026-11-02", -218400, "Anthropic Claude", "Trey Comma"),

  // Google One, with one charge under "Google".
  t("2026-06-28", -1990, "Google One", "🎉 NFFF"),
  t("2026-07-28", -1990, "Google One", "🎉 NFFF"),
  t("2026-08-28", -1990, "Google One", "🎉 NFFF"),
  t("2026-09-28", -1990, "Google", "Trey Comma"),
  t("2026-10-28", -1990, "Google One", "🎉 NFFF"),

  // Apple: $17.46 mostly iCloud; iCloud $6.54 → $7.63.
  t("2026-05-24", -10910, "Apple", "iCloud"),
  t("2026-06-09", -15990, "Apple", "iCloud"),
  t("2026-06-22", -6540, "Apple", "iCloud"),
  t("2026-06-24", -10910, "Apple", "iCloud"),
  t("2026-06-25", -3270, "Apple", "iCloud"),
  t("2026-07-05", -17460, "Apple", "🎉 NFFF"),
  t("2026-07-05", -2170, "Apple", "Trey Comma"),
  t("2026-07-22", -6540, "Apple", "iCloud"),
  t("2026-07-24", -10910, "Apple", "iCloud"),
  t("2026-07-26", -3270, "Apple", "iCloud"),
  t("2026-08-04", -17460, "Apple", "iCloud"),
  t("2026-08-11", -21830, "Apple", "iCloud"),
  t("2026-08-23", -7630, "Apple", "iCloud"),
  t("2026-08-24", -10910, "Apple", "iCloud"),
  t("2026-08-25", -3270, "Apple", "iCloud"),
  t("2026-09-04", -17460, "Apple", "iCloud"),
  t("2026-09-22", -7630, "Apple", "iCloud"),
  t("2026-09-24", -10910, "Apple", "iCloud"),
  t("2026-09-25", -3270, "Apple", "iCloud"),
  t("2026-10-05", -17460, "Apple", "iCloud"),
  t("2026-10-22", -7630, "Apple", "iCloud"),
  t("2026-10-25", -10910, "Apple", "iCloud"),
  t("2026-10-25", -3270, "Apple", "iCloud"),
  t("2026-11-04", -17460, "Apple", "🎉 NFFF"),
  t("2026-11-06", -19990, "Apple", "🎉 NFFF"),

  // Prime Video $18.55 → $21.83, plus a separate $12.00 channel.
  t("2026-05-25", -12000, "Amazon Prime Video Channels", "🎉 NFFF"),
  t("2026-06-04", -18550, "Amazon Prime Video Channels", "🎉 NFFF"),
  t("2026-06-25", -12000, "Amazon Prime Video Channels", "🎉 NFFF"),
  t("2026-07-05", -18550, "Amazon Prime Video Channels", "🎉 NFFF"),
  t("2026-07-26", -12000, "Amazon Prime Video Channels", "HBO Max", { memo: "Amzn" }),
  t("2026-08-04", -18550, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-08-25", -12000, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-09-06", -18550, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-09-27", -12000, "Amazon Prime Video Channels", "🎉 NFFF"),
  t("2026-10-05", -21830, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-10-25", -12000, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-10-29", -16370, "Amazon Prime Video Channels", "HBO Max"),
  t("2026-11-04", -21830, "Amazon Prime Video Channels", "HBO Max"),

  // Apple Card payments: categorized outflows from Checking, not YNAB
  // transfers (case 13). 7 rows, $1,908.17.
  t("2026-06-01", -10000, "Apple Card Payment", "🎉 NFFF", { account: "Checking" }),
  t("2026-07-01", -8000, "Apple Card Payment", "🎉 NFFF", { account: "Checking" }),
  t("2026-08-01", -5000, "Apple Card Payment", "🎉 NFFF", { account: "Checking" }),
  t("2026-09-01", -3460, "Apple Card Payment", "🎉 NFFF", { account: "Checking" }),
  t("2026-10-01", -6680, "Apple Card Payment", "🎉 NFFF", { account: "Checking" }),
  t("2026-10-13", -61110, "Apple Card Payment", "🎉 NFFF", { account: "Checking" }),
  t("2026-10-26", -1813920, "Apple Card Payment", "🎉 NFFF", { account: "Checking" }),
  // A real YNAB transfer, which exclude_transfers already drops.
  t("2026-10-15", -500000, "Transfer : Savings", null, { account: "Checking", transfer: true }),
];
