import { z } from "zod";
import { includeIdsParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  Payee,
  ScheduledTransaction,
  Transaction,
  YnabClient,
} from "../ynab";
import { handleError, result } from "../format";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const PayeeUsageSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Transactions and split parts that carry this payee.
  transaction_count: z.number().int(),
  scheduled_count: z.number().int(),
  // YYYY-MM-DD of the newest transaction, or null if never used.
  last_used: z.string().nullable(),
});
export type PayeeUsage = z.infer<typeof PayeeUsageSchema>;

const EscapedSchema = PayeeUsageSchema.extend({ unescaped_name: z.string() });

// One page of a section. `total` counts every match, `items` holds the page.
const page = <T extends z.ZodType>(item: T) =>
  z.object({ total: z.number().int(), offset: z.number().int(), items: z.array(item) });

export const SECTIONS = ["duplicates", "little_used", "html_escaped", "all"] as const;
export type Section = (typeof SECTIONS)[number];

export const PayeeReviewSchema = z.object({
  payee_count: z.number().int(),
  // Each group: payees whose names match once formatting is ignored, most-used first.
  duplicates: page(z.object({ payees: z.array(PayeeUsageSchema) })).optional(),
  // At most `max_uses` transactions and nothing scheduled, least and oldest use first.
  little_used: page(PayeeUsageSchema).optional(),
  // Names stored with HTML entities ("Board &amp; Brew").
  html_escaped: page(EscapedSchema).optional(),
  // Every payee, most-used first.
  all: page(PayeeUsageSchema).optional(),
});
export type PayeeReview = z.infer<typeof PayeeReviewSchema>;

export interface ReviewOptions {
  maxUses: number;
  query: string;
  show?: Section;
  offset: number;
  limit: number;
}

// ---- Compute (pure)

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Some payees are stored with HTML entities, likely from bank-import data.
export const unescapeHtml = (s: string): string => {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  } while (s !== prev);
  return s;
};

// Card processors prefix the merchant ("SQ *Blue Bottle", "TST* Joe's").
const PROCESSOR_PREFIX = /^(sq|tst|pp|sp|py|paypal)\s*\*\s*/;
// Corporate suffixes and domains that don't distinguish merchants.
const NOISE_WORDS = new Set(["the", "inc", "llc", "ltd", "co", "corp", "com"]);

// Comparison key for the same merchant under different spellings: entities,
// case, accents, punctuation, spacing, store numbers (3+ digits), a processor
// prefix, and corporate suffixes don't count. Every other word does, so
// "Costco Gas", "Amazon Payroll", and "Venmo Jane" stay apart from the bare
// merchant name.
export const payeeKey = (name: string): string =>
  unescapeHtml(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(PROCESSOR_PREFIX, "")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE_WORDS.has(w) && !/^\d{3,}$/.test(w))
    .join("")
    .replace(/\d{3,}$/, "");

const byUse = (a: PayeeUsage, b: PayeeUsage) =>
  b.transaction_count - a.transaction_count ||
  b.scheduled_count - a.scheduled_count ||
  a.name.localeCompare(b.name);

const paginate = <T>(items: T[], offset: number, limit: number) => ({
  total: items.length,
  offset,
  items: items.slice(offset, offset + limit),
});

export const computePayeeReview = (
  payees: Payee[],
  transactions: Transaction[],
  scheduled: ScheduledTransaction[],
  opts: ReviewOptions,
): PayeeReview => {
  // Transfer payees are named after accounts; they are never duplicates.
  const live = payees.filter((p) => !p.deleted && !p.transfer_account_id);
  const usage = new Map<string, PayeeUsage>(
    live.map((p) => [
      p.id,
      { id: p.id, name: p.name, transaction_count: 0, scheduled_count: 0, last_used: null },
    ]),
  );

  const countTx = (payeeId: string | null | undefined, date: string) => {
    const u = payeeId ? usage.get(payeeId) : undefined;
    if (!u) return;
    u.transaction_count++;
    if (!u.last_used || date > u.last_used) u.last_used = date;
  };
  for (const t of transactions) {
    if (t.deleted) continue;
    countTx(t.payee_id, t.date);
    for (const s of t.subtransactions ?? []) {
      if (!s.deleted && s.payee_id !== t.payee_id) countTx(s.payee_id, t.date);
    }
  }
  for (const st of scheduled) {
    if (st.deleted) continue;
    const ids = new Set([
      st.payee_id,
      ...st.subtransactions.filter((s) => !s.deleted).map((s) => s.payee_id),
    ]);
    for (const id of ids) {
      const u = id ? usage.get(id) : undefined;
      if (u) u.scheduled_count++;
    }
  }

  const all = [...usage.values()].sort(byUse);
  const q = opts.query.trim().toLowerCase();
  const matches = (u: PayeeUsage) =>
    !q || u.name.toLowerCase().includes(q) || unescapeHtml(u.name).toLowerCase().includes(q);
  const want = (s: Section) => (opts.show ? opts.show === s : s !== "all");
  const out: PayeeReview = { payee_count: usage.size };

  if (want("duplicates")) {
    const byKey = new Map<string, PayeeUsage[]>();
    for (const u of all) {
      const key = payeeKey(u.name);
      if (key) byKey.set(key, [...(byKey.get(key) ?? []), u]);
    }
    const groupUse = (g: PayeeUsage[]) => g.reduce((n, u) => n + u.transaction_count, 0);
    const groups = [...byKey.values()]
      .filter((g) => g.length > 1 && g.some(matches))
      .sort((a, b) => groupUse(b) - groupUse(a) || a[0].name.localeCompare(b[0].name))
      .map((payees) => ({ payees }));
    out.duplicates = paginate(groups, opts.offset, opts.limit);
  }
  if (want("little_used")) {
    const little = all
      .filter((u) => u.transaction_count <= opts.maxUses && u.scheduled_count === 0 && matches(u))
      .sort(
        (a, b) =>
          a.transaction_count - b.transaction_count ||
          (a.last_used ?? "").localeCompare(b.last_used ?? "") ||
          a.name.localeCompare(b.name),
      );
    out.little_used = paginate(little, opts.offset, opts.limit);
  }
  if (want("html_escaped")) {
    const escaped = all
      .filter((u) => unescapeHtml(u.name) !== u.name && matches(u))
      .map((u) => ({ ...u, unescaped_name: unescapeHtml(u.name) }));
    out.html_escaped = paginate(escaped, opts.offset, opts.limit);
  }
  if (want("all")) {
    out.all = paginate(all.filter(matches), opts.offset, opts.limit);
  }
  return out;
};

// ---- Render (pure)

const fmtUsage = (u: PayeeUsage, includeIds: boolean): string => {
  const n = `${u.transaction_count} transaction${u.transaction_count === 1 ? "" : "s"}`;
  const last = u.last_used ? `, last ${u.last_used}` : "";
  const sched = u.scheduled_count ? `, ${u.scheduled_count} scheduled` : "";
  const id = includeIds ? ` — id ${u.id}` : "";
  return `${u.name} (${n}${last}${sched})${id}`;
};

const pushPage = <T>(
  out: string[],
  title: string,
  section: Section,
  p: { total: number; offset: number; items: T[] },
  line: (item: T) => string,
) => {
  const end = p.offset + p.items.length;
  const range =
    p.items.length && (p.offset > 0 || end < p.total)
      ? ` (${p.offset + 1}–${end} of ${p.total})`
      : ` (${p.total})`;
  out.push(`## ${title}${range}`);
  out.push(...(p.items.length ? p.items.map(line) : ["(none)"]));
  if (end < p.total) out.push(`More: show "${section}", offset ${end}.`);
  out.push("");
};

export const renderPayeeReview = (
  review: PayeeReview,
  opts: ReviewOptions,
  includeIds: boolean,
): string => {
  const q = opts.query.trim();
  const out: string[] = [
    `# Payee review (${review.payee_count} payees${q ? `, filtered to "${q}"` : ""})`,
    "",
  ];
  if (review.duplicates) {
    pushPage(out, "Likely duplicates", "duplicates", review.duplicates, (g) =>
      `- ${g.payees.map((u) => fmtUsage(u, includeIds)).join("; ")}`,
    );
  }
  if (review.html_escaped) {
    pushPage(out, "Names stored with HTML entities", "html_escaped", review.html_escaped, (u) =>
      `- ${fmtUsage(u, includeIds)} → "${u.unescaped_name}"`,
    );
  }
  if (review.little_used) {
    const n = opts.maxUses;
    pushPage(
      out,
      `Little used (≤${n} transaction${n === 1 ? "" : "s"}, nothing scheduled)`,
      "little_used",
      review.little_used,
      (u) => `- ${fmtUsage(u, includeIds)}`,
    );
  }
  if (review.all) {
    pushPage(out, "Payees by use", "all", review.all, (u) => `- ${fmtUsage(u, includeIds)}`);
  }
  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Review payees for cleanup. By default it returns the first page of three " +
  "sections: likely duplicates, names stored with HTML entities (\"Board " +
  "&amp; Brew\"), and little-used payees. Set `show` to one section, plus " +
  "`offset`, to page through it; `show: \"all\"` lists every payee by use. " +
  "`query` narrows every section to names containing it, e.g. `query: " +
  "\"starbucks\"` to judge all of one merchant's payees. Duplicates are " +
  "names that match ignoring case, punctuation, HTML entities, store " +
  "numbers, card-processor prefixes (\"SQ *\"), and suffixes like Inc or " +
  ".com. Any other word keeps names apart, so \"Costco Gas\", \"Amazon " +
  "Payroll\", and \"Venmo Jane\" are not grouped with \"Costco\", \"Amazon\", " +
  "or \"Venmo\", and nicknames like \"AMZN\" are not matched: use `query` and " +
  "judgment for those, and confirm with the user. Each group lists its " +
  "most-used payee first, usually the one to keep. Consolidate with " +
  "merge_payees, fix names with rename_payees. YNAB's API can't delete " +
  "payees; the user removes unused ones in bulk in YNAB's web app (Manage " +
  "Payees, Delete All). Transfer payees are left out. Reads every " +
  "transaction in the plan.";

export const registerReviewPayees = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "review_payees",
    {
      title: "Review Payees",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        show: z
          .enum(SECTIONS)
          .optional()
          .describe("One section to return. Omit for duplicates, html_escaped, and little_used."),
        query: z.string().optional().default("").describe("Only payees whose name contains this."),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(500).optional().default(50).describe("Items per section."),
        max_uses: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(1)
          .describe("A payee with at most this many transactions counts as little used."),
        include_ids: includeIdsParam,
      },
      outputSchema: PayeeReviewSchema.shape,
    },
    async ({ plan_id, show, query, offset, limit, max_uses, include_ids }) => {
      try {
        const c = getClient();
        const [payees, transactions, scheduled] = await Promise.all([
          c.listPayees(plan_id),
          c.listTransactions(plan_id),
          c.listScheduledTransactions(plan_id),
        ]);
        const opts = { maxUses: max_uses, query, show, offset, limit };
        const review = computePayeeReview(
          payees.data.payees,
          transactions.data.transactions,
          scheduled.data.scheduled_transactions,
          opts,
        );
        return result(renderPayeeReview(review, opts, include_ids), review);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
