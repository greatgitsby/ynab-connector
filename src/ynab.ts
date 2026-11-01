const BASE_URL = "https://api.ynab.com/v1";
const TOKEN_URL = "https://app.ynab.com/oauth/token";
const AUTHORIZE_URL = "https://app.ynab.com/oauth/authorize";

export class YnabError extends Error {
  constructor(public status: number, public body: string) {
    super(`YNAB API ${status}: ${body}`);
  }
}

export interface YnabTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

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

const postToken = async (
  body: URLSearchParams,
): Promise<YnabTokenResponse> => {
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
  return JSON.parse(text) as YnabTokenResponse;
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

const txQuery = (opts?: {
  sinceDate?: string;
  untilDate?: string;
  type?: string;
}): string => {
  const params = new URLSearchParams({
    since_date: opts?.sinceDate ?? ALL_TIME,
  });
  if (opts?.untilDate) params.set("until_date", opts.untilDate);
  if (opts?.type) params.set("type", opts.type);
  return `?${params.toString()}`;
};

// Token rotation is not this client's job: the OAuthProvider's
// tokenExchangeCallback (src/token-refresh.ts) refreshes the YNAB token when
// the MCP client refreshes its own, and persists the result in the grant. A 401 here
// surfaces as a YnabError like any other failure.
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
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  // YNAB /user — returns just `{ data: { user: { id } } }`. The id is the
  // stable per-account identifier we hand to `completeAuthorization` as userId.
  getUser() {
    return this.request<{ data: { user: { id: string } } }>("GET", "/user");
  }

  // Plans
  //
  // YNAB v1.79 (2026-03) made `/plans` the resource path and renamed the
  // response keys (`plans` → `plans`, `plan` → `plan`). This codebase
  // follows YNAB's current vocabulary throughout.
  listPlans() {
    return this.request<{
      data: { plans: Plan[]; default_plan?: Plan | null };
    }>("GET", "/plans");
  }
  getPlan(planId: string, lastKnowledgeOfServer?: number) {
    const qs = lastKnowledgeOfServer
      ? `?last_knowledge_of_server=${lastKnowledgeOfServer}`
      : "";
    return this.request<{
      data: { plan: PlanDetail; server_knowledge: number };
    }>("GET", `/plans/${planId}${qs}`);
  }
  // Lightweight: just date/currency format. Use this instead of getPlan
  // when a tool only needs the currency code (e.g. for structured output's
  // `iso` field) — getPlan returns the entire plan payload.
  getPlanSettings(planId: string) {
    return this.request<{
      data: {
        settings: {
          date_format: { format: string } | null;
          currency_format: { iso_code: string; decimal_digits: number } | null;
        };
      };
    }>("GET", `/plans/${planId}/settings`);
  }

  // Accounts
  listAccounts(planId: string) {
    return this.request<{ data: { accounts: Account[] } }>(
      "GET",
      `/plans/${planId}/accounts`,
    );
  }
  getAccount(planId: string, accountId: string) {
    return this.request<{ data: { account: Account } }>(
      "GET",
      `/plans/${planId}/accounts/${accountId}`,
    );
  }
  // `sinceDate` defaults to ALL_TIME, not YNAB's server default — see
  // ALL_TIME for why.
  listAccountTransactions(
    planId: string,
    accountId: string,
    opts?: { sinceDate?: string; untilDate?: string },
  ) {
    return this.request<{ data: { transactions: Transaction[] } }>(
      "GET",
      `/plans/${planId}/accounts/${accountId}/transactions${txQuery(opts)}`,
    );
  }

  // Categories
  listCategories(planId: string) {
    return this.request<{ data: { category_groups: CategoryGroup[] } }>(
      "GET",
      `/plans/${planId}/categories`,
    );
  }
  getCategory(planId: string, categoryId: string) {
    return this.request<{ data: { category: Category } }>(
      "GET",
      `/plans/${planId}/categories/${categoryId}`,
    );
  }
  // Months
  listMonths(planId: string) {
    return this.request<{ data: { months: MonthSummary[] } }>(
      "GET",
      `/plans/${planId}/months`,
    );
  }
  getMonth(planId: string, month: string) {
    return this.request<{ data: { month: MonthDetail } }>(
      "GET",
      `/plans/${planId}/months/${month}`,
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
      `/plans/${planId}/months/${month}/categories/${categoryId}`,
      { category: body },
    );
  }

  // Transactions
  // `sinceDate` defaults to ALL_TIME, not YNAB's server default — see
  // ALL_TIME for why.
  listTransactions(
    planId: string,
    opts?: {
      sinceDate?: string;
      untilDate?: string;
      type?: "uncategorized" | "unapproved";
    },
  ) {
    return this.request<{ data: { transactions: Transaction[] } }>(
      "GET",
      `/plans/${planId}/transactions${txQuery(opts)}`,
    );
  }
  updateTransaction(
    planId: string,
    transactionId: string,
    body: SaveTransactionFields,
  ) {
    return this.request<{ data: { transaction: Transaction } }>(
      "PUT",
      `/plans/${planId}/transactions/${transactionId}`,
      { transaction: body },
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
    }>("PATCH", `/plans/${planId}/transactions`, body);
  }

  // Payees
  listPayees(planId: string) {
    return this.request<{ data: { payees: Payee[] } }>(
      "GET",
      `/plans/${planId}/payees`,
    );
  }
}

// Convert milliunits (YNAB internal format) to dollars.
export const fromMilli = (m: number) => m / 1000;

export interface Plan {
  id: string;
  name: string;
  last_modified_on: string;
  first_month: string;
  last_month: string;
  currency_format?: { iso_code: string; decimal_digits: number };
}

export interface PlanDetail extends Plan {
  accounts?: Account[];
  category_groups?: CategoryGroup[];
  categories?: Category[];
  months?: MonthDetail[];
}

export interface Account {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  deleted?: boolean;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  // Direct-import (linked-bank) status. Absent on accounts that predate the
  // field or were never linked. Note: YNAB's API does NOT expose the bank's
  // reported balance — only these health flags and the last-reconciled time.
  direct_import_linked?: boolean;
  direct_import_in_error?: boolean;
  last_reconciled_at?: string | null;
}

export interface CategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  deleted?: boolean;
  categories: Category[];
}

export interface Category {
  id: string;
  category_group_id: string;
  category_group_name?: string;
  name: string;
  hidden: boolean;
  internal?: boolean;
  deleted?: boolean;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type?: string | null;
  goal_target?: number | null;
  goal_target_date?: string | null;
  goal_cadence?: number | null;
  goal_cadence_frequency?: number | null;
  goal_months_to_budget?: number | null;
  goal_percentage_complete?: number | null;
  goal_under_funded?: number | null;
  goal_overall_funded?: number | null;
  goal_overall_left?: number | null;
  // Set when the user has snoozed the goal for the current month (v1.76).
  goal_snoozed_at?: string | null;
}

export interface MonthSummary {
  month: string;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money: number | null;
}

export interface MonthDetail extends MonthSummary {
  categories: Category[];
}

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  memo: string | null;
  cleared: string;
  approved: boolean;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  flag_color: string | null;
  transfer_account_id: string | null;
  deleted?: boolean;
  subtransactions?: SubTransaction[];
}

export interface SubTransaction {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

export interface Payee {
  id: string;
  name: string;
  transfer_account_id: string | null;
  deleted?: boolean;
}

// A single subtransaction in a write payload. Only the fields the connector's
// tools are willing to set are listed — YNAB tolerates extras but we don't
// expose them. `amount` is the only field YNAB requires.
export interface SaveSubTransaction {
  amount: number;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  memo?: string | null;
}

// Subset of `SaveTransactionWithOptionalFields` from YNAB's OpenAPI spec — the
// fields the connector's update tool can set. Notably excludes `date`,
// `amount`, and `account_id`, which the connector deliberately doesn't expose
// for editing bank-imported rows.
export interface SaveTransactionFields {
  category_id?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  memo?: string | null;
  approved?: boolean;
  cleared?: "cleared" | "uncleared" | "reconciled";
  flag_color?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | null;
  subtransactions?: SaveSubTransaction[];
}

// Bulk-update row: identifies the transaction by `id` and carries any of the
// settable fields. YNAB requires `id` (or `import_id`); we always pass `id`.
export interface SaveTransactionWithId extends SaveTransactionFields {
  id: string;
}
