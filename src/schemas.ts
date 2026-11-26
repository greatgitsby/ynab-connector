import { z } from "zod";

export const planIdParam = z
  .string()
  .default("last-used")
  .describe(
    'YNAB plan id from list_plans. Defaults to "last-used" (the most recently used plan).',
  );

export const monthParam = z.string().regex(/^(\d{4}-\d{2}-01|current)$/, {
  message: "month must be YYYY-MM-01 or 'current'",
});

export const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" });

export const includeIdsParam = z
  .boolean()
  .optional()
  .default(false)
  .describe('Append "— id <uuid>" to each text line.');
