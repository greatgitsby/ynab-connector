import { z } from "zod";
import type {
  Account,
  Category,
  CategoryGroup,
  MonthDetail,
  MoneyMovement,
  MonthSummary,
  Payee,
  Plan,
  PlanDetail,
  ScheduledTransaction,
  Transaction,
} from "./wire";

export type {
  Account,
  Category,
  CategoryGroup,
  MonthDetail,
  MonthSummary,
  MoneyMovement,
  Payee,
  Plan,
  PlanDetail,
  ScheduledTransaction,
  SubTransaction,
  Transaction,
} from "./wire";

const BASE_URL = "https://api.ynab.com/v1";
const TOKEN_URL = "https://app.ynab.com/oauth/token";
const AUTHORIZE_URL = "https://app.ynab.com/oauth/authorize";

export class YnabError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`YNAB API ${status}: ${body}`);
  }
}

const YnabTokenResponseSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});
type YnabTokenResponse = z.infer<typeof YnabTokenResponseSchema>;

export const ynabAuthorizeUrl = (params: {
  client_id: string;
  redirect_uri: string;
  state: string;
  scope?: string;
}): string => {
  const qs = new URLSearchParams({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    response_type: "code",
    state: params.state,
  });
  if (params.scope) qs.set("scope", params.scope);
  return `${AUTHORIZE_URL}?${qs.toString()}`;
};

const postToken = async (body: URLSearchParams): Promise<YnabTokenResponse> => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new YnabError(res.status, text);
  return YnabTokenResponseSchema.parse(JSON.parse(text));
};

export const exchangeYnabCode = (params: {
  client_id: string;
  client_secret: string;
  code: string;
  redirect_uri: string;
}) =>
  postToken(
    new URLSearchParams({
      client_id: params.client_id,
      client_secret: params.client_secret,
      redirect_uri: params.redirect_uri,
      grant_type: "authorization_code",
      code: params.code,
    }),
  );

export const refreshYnabToken = (params: {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}) =>
  postToken(
    new URLSearchParams({
      client_id: params.client_id,
      client_secret: params.client_secret,
      grant_type: "refresh_token",
      refresh_token: params.refresh_token,
    }),
  );

// Earliest date passed as `since_date` when a caller wants every transaction.
// Since YNAB v1.85 (2026-05), transaction listings default `since_date` to
// one year ago when it's omitted, which silently truncates "all uncategorized"
// / "all unreconciled" queries. We always send an explicit lower bound.
export const ALL_TIME = "1900-01-01";

export interface TransactionQuery {
  accountId?: string;
  categoryId?: string;
  payeeId?: string;
  month?: string;
  sinceDate?: string;
  untilDate?: string;
  type?: "uncategorized" | "unapproved";
}

const txQuery = (opts?: TransactionQuery): string => {
  const params = new URLSearchParams({
    since_date: opts?.sinceDate ?? ALL_TIME,
  });
  if (opts?.untilDate) params.set("until_date", opts.untilDate);
  if (opts?.type) params.set("type", opts.type);
  return `?${params.toString()}`;
};

// Ids come from tool arguments, which a prompt-injected model controls. Encode
// each one so an id like "../payees/x" can't retarget a fixed-method request
// at another endpoint. Encoding leaves dots alone, so "." and ".." are refused.
const seg = (id: string): string => {
  if (id === "." || id === "..") throw new Error(`Invalid id: ${id}`);
  return encodeURIComponent(id);
};

export class YnabClient {
  constructor(private token: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: payload,
    });
    const text = await res.text();
    if (!res.ok) throw new YnabError(res.status, text);
    // Typed, not validated: a field YNAB adds or changes should reach the
    // tool as-is rather than fail every call.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  getUser() {
    return this.request<{ data: { user: { id: string } } }>("GET", "/user");
  }

  listPlans() {
    return this.request<{
      data: { plans: Plan[]; default_plan?: Plan | null };
    }>("GET", "/plans");
  }
  // The full plan export. Heavy; use it only for months[].categories[]
  // across many months, which no lighter endpoint returns.
  getPlan(planId: string) {
    return this.request<{ data: { plan: PlanDetail } }>(
      "GET",
      `/plans/${seg(planId)}`,
    );
  }
  getPlanSettings(planId: string) {
    return this.request<{
      data: {
        settings: {
          date_format: { format: string } | null;
          currency_format: { iso_code: string; decimal_digits: number } | null;
        };
      };
    }>("GET", `/plans/${seg(planId)}/settings`);
  }

  async planIso(planId: string): Promise<string> {
    const { data } = await this.getPlanSettings(planId);
    return data.settings.currency_format?.iso_code ?? "USD";
  }

  listAccounts(planId: string) {
    return this.request<{ data: { accounts: Account[] } }>(
      "GET",
      `/plans/${seg(planId)}/accounts`,
    );
  }
  getAccount(planId: string, accountId: string) {
    return this.request<{ data: { account: Account } }>(
      "GET",
      `/plans/${seg(planId)}/accounts/${seg(accountId)}`,
    );
  }
  listCategories(planId: string) {
    return this.request<{ data: { category_groups: CategoryGroup[] } }>(
      "GET",
      `/plans/${seg(planId)}/categories`,
    );
  }
  createCategory(planId: string, body: NewCategory) {
    return this.request<{ data: { category: Category } }>(
      "POST",
      `/plans/${seg(planId)}/categories`,
      { category: body },
    );
  }
  updateCategory(planId: string, categoryId: string, body: SaveCategory) {
    return this.request<{ data: { category: Category } }>(
      "PATCH",
      `/plans/${seg(planId)}/categories/${seg(categoryId)}`,
      { category: body },
    );
  }
  getMonthCategory(planId: string, month: string, categoryId: string) {
    return this.request<{ data: { category: Category } }>(
      "GET",
      `/plans/${seg(planId)}/months/${seg(month)}/categories/${seg(categoryId)}`,
    );
  }
  listMonths(planId: string) {
    return this.request<{ data: { months: MonthSummary[] } }>(
      "GET",
      `/plans/${seg(planId)}/months`,
    );
  }
  getMonth(planId: string, month: string) {
    return this.request<{ data: { month: MonthDetail } }>(
      "GET",
      `/plans/${seg(planId)}/months/${seg(month)}`,
    );
  }

  updateCategoryMonth(
    planId: string,
    month: string,
    categoryId: string,
    body: { budgeted: number },
  ) {
    return this.request<{ data: { category: Category } }>(
      "PATCH",
      `/plans/${seg(planId)}/months/${seg(month)}/categories/${seg(categoryId)}`,
      { category: body },
    );
  }

  listTransactions(planId: string, opts: TransactionQuery = {}) {
    const scope = opts.accountId
      ? `/accounts/${seg(opts.accountId)}`
      : opts.categoryId
        ? `/categories/${seg(opts.categoryId)}`
        : opts.payeeId
          ? `/payees/${seg(opts.payeeId)}`
          : opts.month
            ? `/months/${seg(opts.month)}`
            : "";
    return this.request<{ data: { transactions: Transaction[] } }>(
      "GET",
      `/plans/${seg(planId)}${scope}/transactions${txQuery(opts)}`,
    );
  }
  getTransaction(planId: string, transactionId: string) {
    return this.request<{ data: { transaction: Transaction } }>(
      "GET",
      `/plans/${seg(planId)}/transactions/${seg(transactionId)}`,
    );
  }
  updateTransactionsBulk(
    planId: string,
    body: { transactions: SaveTransactionWithId[] },
  ) {
    return this.request<{
      data: {
        transactions: Transaction[];
        transaction_ids: string[];
      };
    }>("PATCH", `/plans/${seg(planId)}/transactions`, body);
  }

  listPayees(planId: string) {
    return this.request<{ data: { payees: Payee[] } }>(
      "GET",
      `/plans/${seg(planId)}/payees`,
    );
  }
  updatePayee(planId: string, payeeId: string, body: { name: string }) {
    return this.request<{ data: { payee: Payee } }>(
      "PATCH",
      `/plans/${seg(planId)}/payees/${seg(payeeId)}`,
      { payee: body },
    );
  }

  listScheduledTransactions(planId: string) {
    return this.request<{
      data: { scheduled_transactions: ScheduledTransaction[] };
    }>("GET", `/plans/${seg(planId)}/scheduled_transactions`);
  }
  // A full replace: fields left out are cleared, not kept.
  updateScheduledTransaction(
    planId: string,
    scheduledTransactionId: string,
    body: SaveScheduledTransaction,
  ) {
    return this.request<{
      data: { scheduled_transaction: ScheduledTransaction };
    }>(
      "PUT",
      `/plans/${seg(planId)}/scheduled_transactions/${seg(scheduledTransactionId)}`,
      { scheduled_transaction: body },
    );
  }

  // Money movements. Never pass last_knowledge_of_server here: the delta
  // response includes deleted tombstones.
  listMoneyMovements(planId: string) {
    return this.request<{ data: { money_movements: MoneyMovement[] } }>(
      "GET",
      `/plans/${seg(planId)}/money_movements`,
    );
  }
}

export const fromMilli = (m: number) => m / 1000;

export const FLAG_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

export interface SaveSubTransaction {
  amount: number;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  memo?: string | null;
}

export interface SaveTransactionFields {
  category_id?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  memo?: string | null;
  approved?: boolean;
  cleared?: "cleared" | "uncleared" | "reconciled";
  flag_color?: FlagColor | null;
  subtransactions?: SaveSubTransaction[];
}

export interface SaveTransactionWithId extends SaveTransactionFields {
  id: string;
}

// YNAB's `SaveScheduledTransaction`. It has no subtransactions, so a split
// scheduled transaction can't be written through the API.
export interface SaveScheduledTransaction {
  account_id: string;
  date: string;
  amount: number;
  payee_id: string | null;
  category_id: string | null;
  memo: string | null;
  flag_color: string | null;
  frequency: string;
}

// The goal fields of YNAB's `SaveCategory`, the only ones the connector sends.
// `goal_target: null` removes the goal. `hidden` is not among them: YNAB drops
// it (see docs/internals/ynab-api.md).
export const GOAL_FREQUENCIES = ["monthly", "weekly", "yearly"] as const;

export const SaveCategoryGoalSchema = z.object({
  goal_target: z.number().int().nullable().optional(),
  goal_target_date: z.string().nullable().optional(),
  goal_needs_whole_amount: z.boolean().optional(),
  goal_frequency: z.enum(GOAL_FREQUENCIES).optional(),
});
export type SaveCategoryGoal = z.infer<typeof SaveCategoryGoalSchema>;

export interface SaveCategory extends SaveCategoryGoal {
  name?: string;
  category_group_id?: string;
}

export interface NewCategory extends SaveCategoryGoal {
  name: string;
  category_group_id: string;
}
