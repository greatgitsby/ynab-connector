import { z } from "zod";
import { includeIdsParam, monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Account, Transaction, YnabClient } from "../ynab";
import { AccountSchema } from "../wire";
import {
  result,
  handleError,
  fmtMoney,
  fmtPercent,
  padMoney,
  pushSection,
} from "../format";
import {
  monthEndDate,
  monthsBetween,
  resolveMonthRange,
} from "../month-window";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const SnapshotSchema = z.object({
  net: z.number().int(),
  assets: z.number().int(),
  liabilities: z.number().int(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

export const NetWorthReportSchema = z.object({
  iso: z.string(),
  current: SnapshotSchema,
  // End-of-month snapshots, chronological. `change` is null on the first row.
  history: z.array(
    SnapshotSchema.extend({
      month: z.string(),
      change: z.number().int().nullable(),
    }),
  ),
  // Open accounts, largest balance first.
  open_accounts: z.array(AccountSchema),
});
export type NetWorthReport = z.infer<typeof NetWorthReportSchema>;

// ---- Compute (pure)

const snapshot = (balances: number[]): Snapshot => {
  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (b >= 0) assets += b;
    else liabilities += b;
  }
  return { net: assets + liabilities, assets, liabilities };
};

// YNAB has no historical balance endpoint, so each month-end balance is the
// current balance minus every later transaction. Transfers cancel out across
// accounts. `transactions` must cover everything after the first month.
export const computeNetWorth = (
  accounts: Account[],
  transactions: Transaction[],
  opts: { since: string; until: string; iso: string },
): NetWorthReport => {
  const live = accounts.filter((a) => !a.deleted);
  const open = live.filter((a) => !a.closed);
  let prev: number | null = null;
  const history = monthsBetween(opts.since, opts.until).map((month) => {
    const cutoff = monthEndDate(month);
    const balance = new Map(live.map((a) => [a.id, a.balance]));
    for (const t of transactions) {
      if (t.date > cutoff && balance.has(t.account_id)) {
        balance.set(t.account_id, balance.get(t.account_id)! - t.amount);
      }
    }
    const snap = snapshot([...balance.values()]);
    const change = prev === null ? null : snap.net - prev;
    prev = snap.net;
    return { month, ...snap, change };
  });
  return {
    iso: opts.iso,
    current: snapshot(open.map((a) => a.balance)),
    history,
    open_accounts: [...open].sort((a, b) => b.balance - a.balance),
  };
};

// ---- Render (pure)

const COL = 14;

export const renderNetWorth = (
  r: NetWorthReport,
  opts: { includeIds: boolean },
): string => {
  const { iso, current, history } = r;
  const out = [
    `Net worth: ${fmtMoney(current.net, iso)} (assets ${fmtMoney(current.assets, iso)}, liabilities ${fmtMoney(current.liabilities, iso)})`,
    "",
    "## End of month",
    `${"Month".padEnd(9)}${"Net Worth".padStart(COL)}${"Assets".padStart(COL)}${"Liabilities".padStart(COL)}${"Change".padStart(COL)}`,
  ];
  for (const h of history) {
    out.push(
      `${h.month.slice(0, 7).padEnd(9)}${padMoney(h.net, COL, iso)}${padMoney(h.assets, COL, iso)}${padMoney(h.liabilities, COL, iso)}${h.change === null ? "—".padStart(COL) : padMoney(h.change, COL, iso)}`,
    );
  }
  if (history.length >= 2) {
    const first = history[0].net;
    const delta = history[history.length - 1].net - first;
    const pct = first !== 0 ? ` (${fmtPercent(delta, Math.abs(first))})` : "";
    out.push(`Range change: ${fmtMoney(delta, iso)}${pct}`);
  }
  out.push("");
  pushSection(out, "Open accounts", r.open_accounts, r.open_accounts.length, (a) => {
    const idSuffix = opts.includeIds ? ` — id ${a.id}` : "";
    return `- ${a.name} [${a.type}]${a.on_budget ? "" : " (tracking)"}: ${fmtMoney(a.balance, iso)}${idSuffix}`;
  });
  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Reflect: current net worth, end-of-month net worth for each month in a " +
  "range (default the 5 months ending with the current month, YNAB's " +
  "default), and each open account's balance. YNAB's API has no historical " +
  "balance endpoint, so history is worked back from current balances " +
  "through later transactions; transfers cancel out, so it is exact.";

export const registerReflectNetWorth = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "reflect_net_worth",
    {
      title: "Reflect: Net Worth",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        since_month: monthParam.optional(),
        until_month: monthParam.optional().default("current"),
        include_ids: includeIdsParam,
      },
      outputSchema: NetWorthReportSchema.shape,
    },
    async ({ plan_id, since_month, until_month, include_ids }) => {
      try {
        const c = getClient();
        const range = resolveMonthRange(since_month, until_month, 5);
        const [accountsRes, txRes, iso] = await Promise.all([
          c.listAccounts(plan_id),
          c.listTransactions(plan_id, { sinceDate: range.since }),
          c.planIso(plan_id),
        ]);
        const report = computeNetWorth(
          accountsRes.data.accounts,
          txRes.data.transactions,
          { ...range, iso },
        );
        return result(renderNetWorth(report, { includeIds: include_ids }), report);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
