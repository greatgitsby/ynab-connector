import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Account,
  BudgetDetail,
  Transaction,
  YnabClient,
} from "../ynab";
import { text, handleError, fmtMoney, padMoney, pushSection } from "../format";
import { monthEndDate, resolveMonthWindow } from "../month-window";

// ---- Result types

export interface NetWorthSnapshot {
  net: number;
  assets: number;
  liabilities: number;
}

export interface NetWorthHistoryRow {
  month: string;
  snapshot: NetWorthSnapshot | null;
  // Delta from the previous row; null for the first row or when previous is missing.
  delta: number | null;
}

export interface NetWorthReport {
  budgetName: string;
  iso: string;
  requested: string[];
  current: NetWorthSnapshot;
  history: NetWorthHistoryRow[];
  // Open (non-closed, non-deleted) accounts sorted by balance desc.
  openAccounts: Account[];
  // Difference between last and first snapshot, null if the window has < 2 rows.
  rangeChange: { delta: number; firstNet: number } | null;
}

// ---- Tool-local helper

// Reconstruct each month-end balance by walking each account's current
// balance back through its post-cutoff transactions. Transfers cancel
// naturally because they appear on both sides. Closed accounts are kept
// so prior periods stay accurate when an account has since been zeroed
// out and closed.
const historicalNetWorth = (
  accounts: Account[],
  transactions: Transaction[],
  monthKeys: string[],
): Map<string, NetWorthSnapshot> => {
  const valid = accounts.filter((a) => !a.deleted);
  const byAccount = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const arr = byAccount.get(t.account_id);
    if (arr) arr.push(t);
    else byAccount.set(t.account_id, [t]);
  }
  const out = new Map<string, NetWorthSnapshot>();
  for (const key of monthKeys) {
    const cutoff = monthEndDate(key);
    let assets = 0;
    let liabilities = 0;
    for (const a of valid) {
      let bal = a.balance;
      const accTxs = byAccount.get(a.id) ?? [];
      for (const t of accTxs) if (t.date > cutoff) bal -= t.amount;
      if (bal >= 0) assets += bal;
      else liabilities += bal;
    }
    out.set(key, { net: assets + liabilities, assets, liabilities });
  }
  return out;
};

// ---- Compute (pure)

export interface ComputeOpts {
  monthsBack: number;
}

export const computeNetWorth = (
  budget: BudgetDetail,
  transactions: Transaction[],
  opts: ComputeOpts,
): NetWorthReport => {
  const iso = budget.currency_format?.iso_code ?? "USD";
  const accounts = budget.accounts ?? [];
  const requested = resolveMonthWindow(budget, opts.monthsBack).requested;
  const snapshots = historicalNetWorth(accounts, transactions, requested);

  const open = accounts.filter((a) => !a.closed && !a.deleted);
  const curAssets = open
    .filter((a) => a.balance > 0)
    .reduce((s, a) => s + a.balance, 0);
  const curLiab = open
    .filter((a) => a.balance < 0)
    .reduce((s, a) => s + a.balance, 0);

  const history: NetWorthHistoryRow[] = [];
  let prevNet: number | null = null;
  for (const k of requested) {
    const snap = snapshots.get(k) ?? null;
    const delta =
      snap && prevNet !== null ? snap.net - prevNet : null;
    history.push({ month: k, snapshot: snap, delta });
    if (snap) prevNet = snap.net;
  }

  let rangeChange: NetWorthReport["rangeChange"] = null;
  if (requested.length >= 2) {
    const first = snapshots.get(requested[0]);
    const last = snapshots.get(requested[requested.length - 1]);
    if (first && last) {
      rangeChange = { delta: last.net - first.net, firstNet: first.net };
    }
  }

  return {
    budgetName: budget.name,
    iso,
    requested,
    current: {
      net: curAssets + curLiab,
      assets: curAssets,
      liabilities: curLiab,
    },
    history,
    openAccounts: [...open].sort((a, b) => b.balance - a.balance),
    rangeChange,
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

const MAX_ACCOUNTS = 30;
const COL_W = 14;

export const renderNetWorth = (
  report: NetWorthReport,
  opts: RenderOpts,
): string => {
  const { requested, iso, budgetName, current, history, openAccounts } = report;
  const out: string[] = [];

  const winStart = requested[0] ?? "(none)";
  const winEnd = requested[requested.length - 1] ?? "(none)";
  out.push(
    `Net Worth: ${budgetName} — last ${requested.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
  );
  out.push("");

  out.push("## Current snapshot");
  out.push(`Net Worth:   ${fmtMoney(current.net, iso)}`);
  out.push(`Assets:      ${fmtMoney(current.assets, iso)}`);
  out.push(`Liabilities: ${fmtMoney(current.liabilities, iso)}`);
  out.push("");

  out.push(
    `## Historical net worth (end of month, last ${requested.length} months)`,
  );
  out.push(
    `${"Month".padEnd(10)}${"Net Worth".padStart(COL_W)}${"Assets".padStart(COL_W)}${"Liabilities".padStart(COL_W)}${"Change".padStart(COL_W)}`,
  );
  let prevNet: number | null = null;
  for (const row of history) {
    if (!row.snapshot) {
      out.push(`${row.month.slice(0, 7).padEnd(10)}(no data)`);
      continue;
    }
    let changeStr: string;
    if (prevNet == null) {
      changeStr = "—".padStart(COL_W);
    } else {
      const delta = row.snapshot.net - prevNet;
      const pct =
        prevNet !== 0
          ? ` (${delta >= 0 ? "+" : ""}${((delta / Math.abs(prevNet)) * 100).toFixed(1)}%)`
          : "";
      changeStr = `${padMoney(delta, COL_W, iso)}${pct}`;
    }
    out.push(
      `${row.month.slice(0, 7).padEnd(10)}${padMoney(row.snapshot.net, COL_W, iso)}${padMoney(row.snapshot.assets, COL_W, iso)}${padMoney(row.snapshot.liabilities, COL_W, iso)}${changeStr}`,
    );
    prevNet = row.snapshot.net;
  }

  if (report.rangeChange) {
    const { delta, firstNet } = report.rangeChange;
    const pct =
      firstNet !== 0
        ? ` (${((delta / Math.abs(firstNet)) * 100).toFixed(1)}%)`
        : "";
    out.push(`Range change: ${fmtMoney(delta, iso)}${pct}`);
  }
  out.push("");

  pushSection(out, "By account (current)", openAccounts, MAX_ACCOUNTS, (a) => {
    const idSuffix = opts.includeIds ? ` — id ${a.id}` : "";
    return `- ${a.name} [${a.type}] ${a.on_budget ? "(on-budget)" : "(off-budget)"}: ${fmtMoney(a.balance, iso)}${idSuffix}`;
  });

  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Reflect: net worth snapshot plus a historical month-by-month reconstruction over the last N months (default 5, matching YNAB's default). Historical balances are derived by walking each account's current balance back through transaction history — YNAB's REST API doesn't expose a balance-snapshot endpoint, but transfers cancel naturally so the reconstruction is exact. Also lists every account's current balance.";

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
        budget_id: z.string(),
        months_back: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .default(5),
        include_ids: z.boolean().optional().default(false),
      },
    },
    async ({ budget_id, months_back, include_ids }) => {
      try {
        const c = getClient();
        const budgetRes = await c.getBudget(budget_id);
        const budget = budgetRes.data.budget;
        const requested = resolveMonthWindow(budget, months_back).requested;
        const sinceDate = requested[0] ?? budget.first_month;
        const txRes = await c.listTransactions(budget_id, { sinceDate });
        const report = computeNetWorth(budget, txRes.data.transactions, {
          monthsBack: months_back,
        });
        return text(renderNetWorth(report, { includeIds: include_ids }));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
