import type { Category, CategoryGroup } from "../ynab";

const cat = (id: string, name: string, group: string, over: Partial<Category> = {}): Category =>
  ({
    id,
    name,
    category_group_id: group,
    hidden: false,
    internal: false,
    deleted: false,
    budgeted: 0,
    activity: 0,
    balance: 0,
    goal_type: null,
    goal_target: 0,
    ...over,
  }) as Category;

const group = (id: string, name: string, categories: Category[], over: Partial<CategoryGroup> = {}): CategoryGroup =>
  // Template groups carry internal: true in real plans, so it must not block anything.
  ({ id, name, hidden: false, internal: true, deleted: false, categories, ...over }) as CategoryGroup;

export const groups = (): CategoryGroup[] => [
  group("int", "Internal Master Category", [cat("rta", "Inflow: Ready to Assign", "int", { internal: true })]),
  group("cc", "Credit Card Payments", [cat("visa", "Visa", "cc")]),
  group("subs", "Monthly Subscriptions", [cat("netflix", "Netflix", "subs"), cat("old", "Old", "subs", { hidden: true })]),
  group("fun", "Fun", [cat("games", "Games", "fun"), cat("gone", "Gone", "fun", { deleted: true })]),
  group("dead", "Dead", [], { deleted: true }),
];
