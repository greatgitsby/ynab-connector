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

// Refresh callback: returns a fresh access token. The caller (YnabMcp) is
// responsible for persisting the new tokens somewhere durable; this client
// just uses whatever it's handed.
export type RefreshFn = () => Promise<string>;

export class YnabClient {
  constructor(
    private token: string,
    private refresh?: RefreshFn,
  ) {}

  private async request<T>(method: string, path: string): Promise<T> {
    const send = (token: string) =>
      fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

    let res = await send(this.token);
    if (res.status === 401 && this.refresh) {
      this.token = await this.refresh();
      res = await send(this.token);
    }
    const text = await res.text();
    if (!res.ok) throw new YnabError(res.status, text);
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  // YNAB /user — returns just `{ data: { user: { id } } }`. The id is the
  // stable per-account identifier we hand to `completeAuthorization` as userId.
  getUser() {
    return this.request<{ data: { user: { id: string } } }>("GET", "/user");
  }

  // Budgets
  listBudgets() {
    return this.request<{ data: { budgets: Budget[] } }>("GET", "/budgets");
  }
  getBudget(budgetId: string, lastKnowledgeOfServer?: number) {
    const qs = lastKnowledgeOfServer
      ? `?last_knowledge_of_server=${lastKnowledgeOfServer}`
      : "";
    return this.request<{ data: { budget: BudgetDetail } }>(
      "GET",
      `/budgets/${budgetId}${qs}`,
    );
  }

  // Accounts
  listAccounts(budgetId: string) {
    return this.request<{ data: { accounts: Account[] } }>(
      "GET",
      `/budgets/${budgetId}/accounts`,
    );
  }

  // Categories
  listCategories(budgetId: string) {
    return this.request<{ data: { category_groups: CategoryGroup[] } }>(
      "GET",
      `/budgets/${budgetId}/categories`,
    );
  }
  getCategory(budgetId: string, categoryId: string) {
    return this.request<{ data: { category: Category } }>(
      "GET",
      `/budgets/${budgetId}/categories/${categoryId}`,
    );
  }
  // Months
  listMonths(budgetId: string) {
    return this.request<{ data: { months: MonthSummary[] } }>(
      "GET",
      `/budgets/${budgetId}/months`,
    );
  }
  getMonth(budgetId: string, month: string) {
    return this.request<{ data: { month: MonthDetail } }>(
      "GET",
      `/budgets/${budgetId}/months/${month}`,
    );
  }

  // Transactions
  listTransactions(
    budgetId: string,
    opts?: { sinceDate?: string; type?: "uncategorized" | "unapproved" },
  ) {
    const params = new URLSearchParams();
    if (opts?.sinceDate) params.set("since_date", opts.sinceDate);
    if (opts?.type) params.set("type", opts.type);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request<{ data: { transactions: Transaction[] } }>(
      "GET",
      `/budgets/${budgetId}/transactions${qs}`,
    );
  }
}

// Convert milliunits (YNAB internal format) to dollars.
export const fromMilli = (m: number) => m / 1000;

export interface Budget {
  id: string;
  name: string;
  last_modified_on: string;
  first_month: string;
  last_month: string;
  currency_format?: { iso_code: string; decimal_digits: number };
}

export interface BudgetDetail extends Budget {
  accounts?: Account[];
  category_groups?: CategoryGroup[];
  categories?: Category[];
  months?: MonthSummary[];
}

export interface Account {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
}

export interface CategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  categories: Category[];
}

export interface Category {
  id: string;
  category_group_id: string;
  name: string;
  hidden: boolean;
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
