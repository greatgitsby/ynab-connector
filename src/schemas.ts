import { z } from "zod";

// Shared `plan_id` input. YNAB accepts the literal "last-used" in place of a
// plan id (the most recently used plan), so the parameter is optional and
// defaults to it — single-plan users never need to call list_plans first.
export const planIdParam = z
  .string()
  .default("last-used")
  .describe(
    'YNAB plan id from list_plans. Defaults to "last-used" (the most recently used plan).',
  );
