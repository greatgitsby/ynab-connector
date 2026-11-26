import { z } from "zod";
import type { Transaction } from "./ynab";
import { fmtMoney } from "./format";

export interface FlatRow {
  id: string;
  part_id: string | null;
  date: string;
  amount: number;
  payee: string | null;
  payee_id: string | null;
  category: string | null;
  category_id: string | null;
  account: string;
  account_id: string;
  memo: string | null;
  approved: boolean;
  cleared: string;
  flag: string | null;
  transfer: boolean;
  imported: boolean;
}

export const flattenTransactions = (txs: Transaction[]): FlatRow[] =>
  txs
    .filter((t) => !t.deleted)
    .flatMap((t): FlatRow[] => {
      const base: FlatRow = {
        id:
          t.type === "subtransaction" && t.parent_transaction_id
            ? t.parent_transaction_id
            : t.id,
        part_id: t.type === "subtransaction" ? t.id : null,
        date: t.date,
        amount: t.amount,
        payee: t.payee_name ?? null,
        payee_id: t.payee_id ?? null,
        category: t.category_name ?? null,
        category_id: t.category_id ?? null,
        account: t.account_name,
        account_id: t.account_id,
        memo: t.memo ?? null,
        approved: t.approved,
        cleared: t.cleared,
        flag: t.flag_color ?? null,
        transfer: t.transfer_account_id != null,
        imported: t.import_id != null,
      };
      const parts = (t.subtransactions ?? []).filter((s) => !s.deleted);
      if (!parts.length) return [base];
      return parts.map((s) => ({
        ...base,
        part_id: s.id,
        amount: s.amount,
        payee: s.payee_name ?? base.payee,
        payee_id: s.payee_id ?? base.payee_id,
        category: s.category_name ?? null,
        category_id: s.category_id ?? null,
        memo: s.memo ?? base.memo,
        transfer: s.transfer_account_id != null,
      }));
    });

export const ROW_FIELDS = [
  "id",
  "date",
  "amount",
  "payee",
  "category",
  "account",
  "memo",
  "approved",
  "cleared",
  "flag",
  "payee_id",
  "category_id",
  "account_id",
] as const;
export type RowField = (typeof ROW_FIELDS)[number];
export const DEFAULT_ROW_FIELDS: RowField[] = [
  "id",
  "date",
  "amount",
  "payee",
  "category",
  "account",
  "memo",
];

export const rowFieldsParam = z
  .array(z.enum(ROW_FIELDS))
  .min(1)
  .optional()
  .describe(
    `Row fields to return. Default: ${DEFAULT_ROW_FIELDS.join(", ")}. A split part also carries part_id when id is chosen. Null memo and flag are left out.`,
  );

export const RowSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Transaction id for update_transactions. A split part carries its parent's id here and its own in part_id.",
    ),
  part_id: z.string().optional(),
  date: z.string().optional(),
  amount: z.number().int().optional(),
  payee: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  account: z.string().optional(),
  memo: z.string().optional(),
  approved: z.boolean().optional(),
  cleared: z.string().optional(),
  flag: z.string().optional(),
  payee_id: z.string().nullable().optional(),
  category_id: z.string().nullable().optional(),
  account_id: z.string().optional(),
});
export type Row = z.infer<typeof RowSchema>;

export const pickRow = (
  r: FlatRow,
  fields: readonly RowField[] = DEFAULT_ROW_FIELDS,
): Row => {
  const entries = fields.flatMap((f) => {
    if ((f === "memo" || f === "flag") && r[f] == null) return [];
    if (f === "id" && r.part_id)
      return [
        [f, r[f]],
        ["part_id", r.part_id],
      ];
    return [[f, r[f]]];
  });
  return RowSchema.parse(Object.fromEntries(entries));
};

export const fmtRowLine = (
  r: {
    id?: string;
    part_id?: string | null;
    date?: string;
    amount?: number;
    payee?: string | null;
    category?: string | null;
    account?: string;
    memo?: string | null;
    approved?: boolean;
  },
  iso: string,
  includeIds: boolean,
): string => {
  const memo = r.memo ? ` "${r.memo}"` : "";
  const account = r.account ? ` [${r.account}]` : "";
  const approval = r.approved === false ? " (unapproved)" : "";
  const ids =
    includeIds && r.id
      ? ` — id ${r.id}${r.part_id ? ` part ${r.part_id}` : ""}`
      : "";
  return `- ${r.date ?? ""} ${r.amount != null ? fmtMoney(r.amount, iso) : ""} ${r.payee ?? "(no payee)"} → ${r.category ?? "(uncategorized)"}${account}${memo}${approval}${ids}`;
};

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
