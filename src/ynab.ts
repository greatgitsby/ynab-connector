const BASE_URL = "https://api.ynab.com/v1";

export class YnabError extends Error {
  constructor(public status: number, public body: string) {
    super(`YNAB API ${status}: ${body}`);
  }
}

export class YnabClient {
  constructor(private token: string) {}

  private async request<T>(method: string, path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) throw new YnabError(res.status, text);
    return text ? (JSON.parse(text) as T) : ({} as T);
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
