import { z } from "zod";

// YNAB wire objects, transcribed from the v1.88 OpenAPI spec
// (https://api.ynab.com/papi/open_api_spec.yaml). Fields the spec lists as
// required are required here; everything else is optional, because some
// endpoints omit fields others send (see docs/internals/ynab-api.md).
// Enums stay plain strings so a new YNAB value can't fail outputSchema
// validation at call time.
//
// Every milliunit field has `*_formatted` (display string in the plan's
// currency) and `*_currency` (decimal amount) siblings. They are declared so
// the schema matches the wire, but tools compute and format from milliunits
// only.
//
// Every schema is a looseObject: YNAB objects pass through verbatim, so a
// field a later API version adds must not fail validation. A strict z.object
// emits `additionalProperties: false`, and the client rejects the whole call.

const nullableString = z.string().nullable().optional();
const nullableInt = z.number().int().nullable().optional();
const formatted = z.string().optional();
const currency = z.number().optional();
const nullableFormatted = z.string().nullable().optional();
const nullableCurrency = z.number().nullable().optional();

export const CurrencyFormatSchema = z.looseObject({
  iso_code: z.string(),
  example_format: z.string(),
  decimal_digits: z.number().int(),
  decimal_separator: z.string(),
  symbol_first: z.boolean(),
  group_separator: z.string(),
  currency_symbol: z.string(),
  display_symbol: z.boolean(),
});

export const DateFormatSchema = z.looseObject({
  format: z.string(),
});

// Loan-account values keyed by effective month (YYYY-MM-DD), in milliunits
// (interest rates in thousandths of a percent).
const LoanAccountPeriodicValueSchema = z
  .record(z.string(), z.number().int())
  .nullable()
  .optional();

export const AccountSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  on_budget: z.boolean(),
  closed: z.boolean(),
  note: nullableString,
  balance: z.number().int(),
  balance_formatted: formatted,
  balance_currency: currency,
  cleared_balance: z.number().int(),
  cleared_balance_formatted: formatted,
  cleared_balance_currency: currency,
  uncleared_balance: z.number().int(),
  uncleared_balance_formatted: formatted,
  uncleared_balance_currency: currency,
  transfer_payee_id: z.string().nullable(),
  // Linked-bank health. YNAB never exposes the bank's reported balance.
  direct_import_linked: z.boolean().optional(),
  direct_import_in_error: z.boolean().optional(),
  last_reconciled_at: nullableString,
  // Deprecated by YNAB; always null.
  debt_original_balance: nullableInt,
  debt_interest_rates: LoanAccountPeriodicValueSchema,
  debt_minimum_payments: LoanAccountPeriodicValueSchema,
  debt_escrow_amounts: LoanAccountPeriodicValueSchema,
  deleted: z.boolean(),
});
export type Account = z.infer<typeof AccountSchema>;

export const PlanSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  last_modified_on: z.string().optional(),
  first_month: z.string().optional(),
  last_month: z.string().optional(),
  date_format: DateFormatSchema.nullable().optional(),
  currency_format: CurrencyFormatSchema.nullable().optional(),
  // Only with `include_accounts=true` on GET /plans.
  accounts: z.array(AccountSchema).optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const CategorySchema = z.looseObject({
  id: z.string(),
  category_group_id: z.string(),
  // Absent from GET /plans/{id}; present on /categories and /months/{month}.
  category_group_name: z.string().optional(),
  name: z.string(),
  hidden: z.boolean(),
  internal: z.boolean(),
  // Deprecated by YNAB; always null.
  original_category_group_id: nullableString,
  note: nullableString,
  budgeted: z.number().int(),
  budgeted_formatted: formatted,
  budgeted_currency: currency,
  activity: z.number().int(),
  activity_formatted: formatted,
  activity_currency: currency,
  balance: z.number().int(),
  balance_formatted: formatted,
  balance_currency: currency,
  goal_type: nullableString,
  goal_needs_whole_amount: z.boolean().nullable().optional(),
  goal_day: nullableInt,
  goal_cadence: nullableInt,
  goal_cadence_frequency: nullableInt,
  goal_creation_month: nullableString,
  goal_target: nullableInt,
  goal_target_formatted: nullableFormatted,
  goal_target_currency: nullableCurrency,
  // Deprecated by YNAB, but GET /plans/{id} still sends only this one.
  goal_target_month: nullableString,
  goal_target_date: nullableString,
  goal_percentage_complete: nullableInt,
  goal_months_to_budget: nullableInt,
  goal_under_funded: nullableInt,
  goal_under_funded_formatted: nullableFormatted,
  goal_under_funded_currency: nullableCurrency,
  goal_overall_funded: nullableInt,
  goal_overall_funded_formatted: nullableFormatted,
  goal_overall_funded_currency: nullableCurrency,
  goal_overall_left: nullableInt,
  goal_overall_left_formatted: nullableFormatted,
  goal_overall_left_currency: nullableCurrency,
  goal_snoozed_at: nullableString,
  deleted: z.boolean(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryGroupSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  hidden: z.boolean(),
  internal: z.boolean(),
  deleted: z.boolean(),
  // Null on GET /plans/{id}.
  categories: z.array(CategorySchema).nullable().optional(),
});
export type CategoryGroup = z.infer<typeof CategoryGroupSchema>;

export const MonthSummarySchema = z.looseObject({
  month: z.string(),
  note: nullableString,
  income: z.number().int(),
  income_formatted: formatted,
  income_currency: currency,
  budgeted: z.number().int(),
  budgeted_formatted: formatted,
  budgeted_currency: currency,
  activity: z.number().int(),
  activity_formatted: formatted,
  activity_currency: currency,
  to_be_budgeted: z.number().int(),
  to_be_budgeted_formatted: formatted,
  to_be_budgeted_currency: currency,
  age_of_money: nullableInt,
  deleted: z.boolean(),
});
export type MonthSummary = z.infer<typeof MonthSummarySchema>;

export const MonthDetailSchema = MonthSummarySchema.extend({
  categories: z.array(CategorySchema),
});
export type MonthDetail = z.infer<typeof MonthDetailSchema>;

export const SubTransactionSchema = z.looseObject({
  id: z.string(),
  transaction_id: z.string(),
  amount: z.number().int(),
  amount_formatted: formatted,
  amount_currency: currency,
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
export const TransactionSchema = z.looseObject({
  id: z.string(),
  date: z.string(),
  amount: z.number().int(),
  amount_formatted: formatted,
  amount_currency: currency,
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

export const PayeeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  transfer_account_id: nullableString,
  deleted: z.boolean(),
});
export type Payee = z.infer<typeof PayeeSchema>;

export const ScheduledSubTransactionSchema = z.looseObject({
  id: z.string(),
  scheduled_transaction_id: z.string(),
  amount: z.number().int(),
  amount_formatted: formatted,
  amount_currency: currency,
  memo: nullableString,
  payee_id: nullableString,
  payee_name: nullableString,
  category_id: nullableString,
  category_name: nullableString,
  transfer_account_id: nullableString,
  deleted: z.boolean(),
});

export const ScheduledTransactionSchema = z.looseObject({
  id: z.string(),
  date_first: z.string(),
  date_next: z.string(),
  frequency: z.string(),
  amount: z.number().int(),
  amount_formatted: formatted,
  amount_currency: currency,
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

export const PayeeLocationSchema = z.looseObject({
  id: z.string(),
  payee_id: z.string(),
  latitude: z.string(),
  longitude: z.string(),
  deleted: z.boolean(),
});
export type PayeeLocation = z.infer<typeof PayeeLocationSchema>;

// GET /plans/{id} is a full export: flat summary rows that reference
// accounts, payees, and categories by id only, so the detail rows' name
// fields and nested subtransactions are absent.
const TransactionSummarySchema = TransactionSchema.omit({
  account_name: true,
  payee_name: true,
  category_name: true,
  subtransactions: true,
  type: true,
  parent_transaction_id: true,
});
const ScheduledTransactionSummarySchema = ScheduledTransactionSchema.omit({
  account_name: true,
  payee_name: true,
  category_name: true,
  subtransactions: true,
});

export const PlanDetailSchema = PlanSchema.extend({
  accounts: z.array(AccountSchema).optional(),
  payees: z.array(PayeeSchema).optional(),
  payee_locations: z.array(PayeeLocationSchema).optional(),
  category_groups: z.array(CategoryGroupSchema).optional(),
  categories: z.array(CategorySchema).optional(),
  months: z.array(MonthDetailSchema).optional(),
  transactions: z.array(TransactionSummarySchema).optional(),
  subtransactions: z.array(SubTransactionSchema).optional(),
  scheduled_transactions: z.array(ScheduledTransactionSummarySchema).optional(),
  scheduled_subtransactions: z.array(ScheduledSubTransactionSchema).optional(),
});
export type PlanDetail = z.infer<typeof PlanDetailSchema>;

// A null `from_category_id` is Ready to Assign (an assignment); a null
// `to_category_id` returns money to Ready to Assign.
export const MoneyMovementSchema = z.looseObject({
  id: z.string(),
  month: nullableString,
  moved_at: nullableString,
  note: nullableString,
  money_movement_group_id: nullableString,
  performed_by_user_id: nullableString,
  from_category_id: nullableString,
  to_category_id: nullableString,
  amount: z.number().int(),
  amount_formatted: formatted,
  amount_currency: currency,
  deleted: z.boolean().optional(),
});
export type MoneyMovement = z.infer<typeof MoneyMovementSchema>;
