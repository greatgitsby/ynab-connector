import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Payee, YnabClient } from "../ynab";
import { PayeeSchema } from "../wire";
import { result, handleError } from "../format";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

export const PayeeListSchema = z.object({
  // Shortest name first, capped at `limit`.
  payees: z.array(PayeeSchema),
  total_matched: z.number().int(),
});
export type PayeeList = z.infer<typeof PayeeListSchema>;

// ---- Compute (pure)

export const computePayeeList = (
  payees: Payee[],
  query: string,
  limit: number,
): PayeeList => {
  const q = query.trim().toLowerCase();
  const all = payees
    .filter((p) => !p.deleted && p.name.toLowerCase().includes(q))
    .sort(
      (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
    );
  return { payees: all.slice(0, limit), total_matched: all.length };
};

// ---- Render (pure)

export const renderPayeeList = (list: PayeeList, query: string): string => {
  const q = query.trim();
  if (!list.payees.length) return q ? `No payees match "${q}".` : "No payees.";
  const what = q ? `Payees matching "${q}"` : "Payees";
  const header =
    list.total_matched > list.payees.length
      ? `## ${what} (showing ${list.payees.length} of ${list.total_matched})`
      : `## ${what} (${list.total_matched})`;
  const lines = list.payees.map(
    (p) => `- ${p.name}${p.transfer_account_id ? " (transfer)" : ""} — id ${p.id}`,
  );
  return [header, ...lines].join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "List payees, optionally only those whose name contains `query` " +
  "(case-insensitive). Use the returned ids for list_transactions(payee_id) " +
  "and for update_transactions; passing a payee name to update_transactions " +
  "instead can make YNAB create a duplicate payee. One merchant may appear " +
  "under several payees.";

export const registerListPayees = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_payees",
    {
      title: "List Payees",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        query: z.string().optional().default(""),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
      outputSchema: PayeeListSchema.shape,
    },
    async ({ plan_id, query, limit }) => {
      try {
        const { data } = await getClient().listPayees(plan_id);
        const list = computePayeeList(data.payees, query, limit);
        return result(renderPayeeList(list, query), list);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
