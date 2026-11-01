import { z } from "zod";

// YNAB wire objects, transcribed from the v1.88 OpenAPI spec
// (https://api.ynab.com/papi/open_api_spec.yaml). Fields the spec lists as
// required are required here; everything else is optional, because some
// endpoints omit fields others send (see docs/internals/ynab-api.md).
// Enums stay plain strings so a new YNAB value can't fail outputSchema
// validation at call time. The `*_formatted` / `*_currency` siblings are left
// out on purpose: money stays in milliunits.

const nullableString = z.string().nullable().optional();
const nullableInt = z.number().int().nullable().optional();

export const CurrencyFormatSchema = z.object({
  iso_code: z.string(),
  decimal_digits: z.number().int(),
});

export const PlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  last_modified_on: z.string().optional(),
  first_month: z.string().optional(),
  last_month: z.string().optional(),
  currency_format: CurrencyFormatSchema.nullable().optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  on_budget: z.boolean(),
  closed: z.boolean(),
  note: nullableString,
  balance: z.number().int(),
  cleared_balance: z.number().int(),
  uncleared_balance: z.number().int(),
  transfer_payee_id: z.string().nullable(),
  // Linked-bank health. YNAB never exposes the bank's reported balance.
  direct_import_linked: z.boolean().optional(),
  direct_import_in_error: z.boolean().optional(),
  last_reconciled_at: nullableString,
  deleted: z.boolean(),
});
export type Account = z.infer<typeof AccountSchema>;

export const CategorySchema = z.object({
  id: z.string(),
  category_group_id: z.string(),
  // Absent from GET /plans/{id}; present on /categories and /months/{month}.
  category_group_name: z.string().optional(),
  name: z.string(),
  hidden: z.boolean(),
  internal: z.boolean(),
  note: nullableString,
  budgeted: z.number().int(),
  activity: z.number().int(),
  balance: z.number().int(),
  goal_type: nullableString,
  goal_needs_whole_amount: z.boolean().nullable().optional(),
  goal_day: nullableInt,
  goal_cadence: nullableInt,
  goal_cadence_frequency: nullableInt,
  goal_creation_month: nullableString,
  goal_target: nullableInt,
  // Deprecated by YNAB, but GET /plans/{id} still sends only this one.
  goal_target_month: nullableString,
  goal_target_date: nullableString,
  goal_percentage_complete: nullableInt,
  goal_months_to_budget: nullableInt,
  goal_under_funded: nullableInt,
  goal_overall_funded: nullableInt,
  goal_overall_left: nullableInt,
  goal_snoozed_at: nullableString,
  deleted: z.boolean(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  hidden: z.boolean(),
  internal: z.boolean(),
  deleted: z.boolean(),
  // Null on GET /plans/{id}.
  categories: z.array(CategorySchema).nullable().optional(),
});
export type CategoryGroup = z.infer<typeof CategoryGroupSchema>;

export const MonthSummarySchema = z.object({
  month: z.string(),
  note: nullableString,
  income: z.number().int(),
  budgeted: z.number().int(),
  activity: z.number().int(),
  to_be_budgeted: z.number().int(),
  age_of_money: nullableInt,
  deleted: z.boolean(),
});
export type MonthSummary = z.infer<typeof MonthSummarySchema>;

export const MonthDetailSchema = MonthSummarySchema.extend({
  categories: z.array(CategorySchema),
});
export type MonthDetail = z.infer<typeof MonthDetailSchema>;

export const PlanDetailSchema = PlanSchema.extend({
  accounts: z.array(AccountSchema).optional(),
  category_groups: z.array(CategoryGroupSchema).optional(),
  categories: z.array(CategorySchema).optional(),
  months: z.array(MonthDetailSchema).optional(),
});
export type PlanDetail = z.infer<typeof PlanDetailSchema>;

export const SubTransactionSchema = z.object({
  id: z.string(),
  transaction_id: z.string(),
  amount: z.number().int(),
  memo: nullableString,
  payee_id: nullableString,
  payee_name: nullableString,
  category_id: nullableString,
  category_name: nullableString,
  transfer_account_id: nullableString,
  transfer_transaction_id: nullableString,
  deleted: z.boolean(),
});
export type SubTransaction = z.infer<typeof SubTransactionSchema>;

// TransactionDetail and HybridTransaction share one schema. Detail rows
// (plan, account, and month listings) carry `subtransactions`; hybrid rows
// (category and payee listings) flatten splits into separate rows with
// `type: "subtransaction"` and `parent_transaction_id`.
export const TransactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number().int(),
  memo: nullableString,
  cleared: z.string(),
  approved: z.boolean(),
  flag_color: nullableString,
  flag_name: nullableString,
  account_id: z.string(),
  account_name: z.string(),
  payee_id: nullableString,
  payee_name: nullableString,
  category_id: nullableString,
  category_name: nullableString,
  transfer_account_id: nullableString,
  transfer_transaction_id: nullableString,
  matched_transaction_id: nullableString,
  import_id: nullableString,
  import_payee_name: nullableString,
  import_payee_name_original: nullableString,
  debt_transaction_type: nullableString,
  deleted: z.boolean(),
  subtransactions: z.array(SubTransactionSchema).optional(),
  type: z.enum(["transaction", "subtransaction"]).optional(),
  parent_transaction_id: nullableString,
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const PayeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  transfer_account_id: nullableString,
  deleted: z.boolean(),
});
export type Payee = z.infer<typeof PayeeSchema>;

export const ScheduledSubTransactionSchema = z.object({
  id: z.string(),
  scheduled_transaction_id: z.string(),
  amount: z.number().int(),
  memo: nullableString,
  payee_id: nullableString,
  payee_name: nullableString,
  category_id: nullableString,
  category_name: nullableString,
  transfer_account_id: nullableString,
  deleted: z.boolean(),
});

export const ScheduledTransactionSchema = z.object({
  id: z.string(),
  date_first: z.string(),
  date_next: z.string(),
  frequency: z.string(),
  amount: z.number().int(),
  memo: nullableString,
  flag_color: nullableString,
  flag_name: nullableString,
  account_id: z.string(),
  account_name: z.string(),
  payee_id: nullableString,
  payee_name: nullableString,
  category_id: nullableString,
  category_name: nullableString,
  transfer_account_id: nullableString,
  deleted: z.boolean(),
  subtransactions: z.array(ScheduledSubTransactionSchema),
});
export type ScheduledTransaction = z.infer<typeof ScheduledTransactionSchema>;

// A null `from_category_id` is Ready to Assign (an assignment); a null
// `to_category_id` returns money to Ready to Assign.
export const MoneyMovementSchema = z.object({
  id: z.string(),
  month: nullableString,
  moved_at: nullableString,
  note: nullableString,
  money_movement_group_id: nullableString,
  performed_by_user_id: nullableString,
  from_category_id: nullableString,
  to_category_id: nullableString,
  amount: z.number().int(),
});
export type MoneyMovement = z.infer<typeof MoneyMovementSchema>;
