import { z } from "zod";
import { includeIdsParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Account, MonthDetail, Transaction, YnabClient } from "../ynab";
import { fmtMoney, handleError, result } from "../format";
import {
  RowSchema,
  addDays,
  fmtRowLine,
  flattenTransactions,
  pickRow,
  todayIso,
  type FlatRow,
} from "../rows";
import { computeTriageInbox } from "./triage-inbox";
import { isTrackingAccount } from "../predicates";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const CategoryAmountSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount: z.number().int(),
});

const AccountRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  on_budget: z.boolean(),
  cleared: z.number().int(),
  uncleared: z.number().int(),
  // cleared + uncleared, YNAB's `balance`.
  working: z.number().int(),
  linked: z.boolean(),
  link_error: z.boolean(),
  last_reconciled_at: z.string().nullable(),
});

const SectionSchema = z.object({
  count: z.number().int(),
  rows: z.array(RowSchema),
});

export const SnapshotSchema = z.object({
  iso: z.string(),
  month: z.string(),
  ready_to_assign: z.number().int(),
  age_of_money: z.number().int().nullable(),
  // Same membership as triage_inbox, as compact rows, newest first.
  uncategorized: SectionSchema,
  unapproved: SectionSchema,
  overspent: z.object({
    count: z.number().int(),
    total: z.number().int(),
    categories: z.array(CategoryAmountSchema),
  }),
  underfunded: z.object({
    count: z.number().int(),
    total: z.number().int(),
    categories: z.array(CategoryAmountSchema),
  }),
  // Open accounts, on-plan first.
  accounts: z.array(AccountRowSchema),
  // Imported transactions dated within the last `recent_days`, newest first.
  recent_imports: SectionSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---- Compute (pure)

export const computeSnapshot = (
  input: {
    uncategorized: Transaction[];
    unapproved: Transaction[];
    recent: Transaction[];
    month: MonthDetail;
    accounts: Account[];
  },
  opts: { iso: string; maxRows: number; recentSince: string },
): Snapshot => {
  const tracking = new Set(input.accounts.filter(isTrackingAccount).map((a) => a.id));
  const inbox = computeTriageInbox(input.uncategorized, input.unapproved, input.month, {
    iso: opts.iso,
    trackingAccountIds: tracking,
  });
  const section = (rows: FlatRow[]) => ({
    count: rows.length,
    rows: rows.slice(0, opts.maxRows).map((r) => pickRow(r)),
  });
  const recent = flattenTransactions(input.recent)
    .filter((r) => r.imported && r.date >= opts.recentSince)
    .sort((a, b) => b.date.localeCompare(a.date));
  const sum = (xs: { amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0);
  const overspent = inbox.overspent.map((c) => ({ id: c.id, name: c.name, amount: c.balance }));
  const underfunded = inbox.underfunded.map((u) => ({ id: u.id, name: u.name, amount: u.underfunded }));
  return {
    iso: opts.iso,
    month: inbox.month,
    ready_to_assign: inbox.ready_to_assign,
    age_of_money: input.month.age_of_money ?? null,
    uncategorized: section(flattenTransactions(inbox.uncategorized)),
    unapproved: section(flattenTransactions(inbox.auto_categorized)),
    overspent: { count: overspent.length, total: sum(overspent), categories: overspent },
    underfunded: { count: underfunded.length, total: sum(underfunded), categories: underfunded },
    accounts: input.accounts
      .filter((a) => !a.deleted && !a.closed)
      .sort((a, b) => Number(b.on_budget) - Number(a.on_budget))
      .map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        on_budget: a.on_budget,
        cleared: a.cleared_balance,
        uncleared: a.uncleared_balance,
        working: a.balance,
        linked: !!a.direct_import_linked,
        link_error: !!a.direct_import_in_error,
        last_reconciled_at: a.last_reconciled_at ?? null,
      })),
    recent_imports: section(recent),
  };
};

// ---- Render (pure)

export const renderSnapshot = (s: Snapshot, opts: { includeIds: boolean }): string => {
  const { iso } = s;
  const out = [
    `Snapshot for ${s.month.slice(0, 7)}`,
    `Ready to Assign: ${fmtMoney(s.ready_to_assign, iso)}${s.age_of_money != null ? ` · age of money ${s.age_of_money} days` : ""}`,
    `Overspent: ${s.overspent.count} (${fmtMoney(s.overspent.total, iso)}) · Underfunded goals: ${s.underfunded.count} (${fmtMoney(s.underfunded.total, iso)})`,
    "",
  ];
  const section = (title: string, { count, rows }: Snapshot["uncategorized"]) => {
    out.push(`## ${title} (${rows.length < count ? `${rows.length} of ${count}` : count})`);
    if (!count) out.push("(none)");
    for (const r of rows) out.push(fmtRowLine(r, iso, opts.includeIds));
    out.push("");
  };
  section("Uncategorized", s.uncategorized);
  section("Unapproved", s.unapproved);
  if (s.overspent.count) {
    out.push("## Overspent");
    for (const c of s.overspent.categories) out.push(`- ${c.name}: ${fmtMoney(c.amount, iso)}`);
    out.push("");
  }
  if (s.underfunded.count) {
    out.push("## Underfunded");
    for (const c of s.underfunded.categories) out.push(`- ${c.name}: needs ${fmtMoney(c.amount, iso)}`);
    out.push("");
  }
  out.push("## Accounts (cleared / working)");
  for (const a of s.accounts) {
    const link = a.link_error ? " ⚠ link error" : "";
    const off = a.on_budget ? "" : " (tracking)";
    out.push(`- ${a.name}${off}: ${fmtMoney(a.cleared, iso)} / ${fmtMoney(a.working, iso)}${link}`);
  }
  out.push("");
  section("Recent imports", s.recent_imports);
  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "A compact snapshot of the plan in one call: Ready to Assign, age of money, uncategorized and unapproved transactions (as compact rows), " +
  "overspent categories and underfunded goals with totals, every open account's cleared and working balance and bank-link health, " +
  "and transactions imported in the last `recent_days` days. Same inbox rules as triage_inbox (tracking accounts and approved transfers left out), " +
  "which shows full YNAB objects instead. Rows per section are capped by max_rows; counts cover everything.";

export const registerGetSnapshot = (server: McpServer, getClient: () => YnabClient) => {
  server.registerTool(
    "get_snapshot",
    {
      title: "Get Snapshot",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        max_rows: z.number().int().min(0).max(500).optional().default(50),
        recent_days: z.number().int().min(1).max(60).optional().default(7),
        include_ids: includeIdsParam,
      },
      outputSchema: SnapshotSchema.shape,
    },
    async ({ plan_id, max_rows, recent_days, include_ids }) => {
      try {
        const c = getClient();
        const recentSince = addDays(todayIso(), -recent_days);
        const [uncat, unapproved, recent, month, accounts, iso] = await Promise.all([
          c.listTransactions(plan_id, { type: "uncategorized" }),
          c.listTransactions(plan_id, { type: "unapproved" }),
          c.listTransactions(plan_id, { sinceDate: recentSince }),
          c.getMonth(plan_id, "current"),
          c.listAccounts(plan_id),
          c.planIso(plan_id),
        ]);
        const s = computeSnapshot(
          {
            uncategorized: uncat.data.transactions,
            unapproved: unapproved.data.transactions,
            recent: recent.data.transactions,
            month: month.data.month,
            accounts: accounts.data.accounts,
          },
          { iso, maxRows: max_rows, recentSince },
        );
        return result(renderSnapshot(s, { includeIds: include_ids }), s);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
