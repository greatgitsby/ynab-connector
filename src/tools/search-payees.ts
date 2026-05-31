import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Payee, YnabClient } from "../ynab";
import { result, handleError } from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see ADR 0002).
// Payees carry no money amounts, so there is no currency code on this payload.

const PayeeMatchSchema = z.object({
  id: z.string(),
  name: z.string(),
  transfer_account_id: z.string().nullable(),
});
export type PayeeMatch = z.infer<typeof PayeeMatchSchema>;

export const PayeeSearchResultSchema = z.object({
  matches: z.array(PayeeMatchSchema),
  totalMatched: z.number().int(),
  cap: z.number().int(),
});
export type PayeeSearchResult = z.infer<typeof PayeeSearchResultSchema>;

// ---- Compute (pure)

export const computePayeeSearch = (
  payees: Payee[],
  query: string,
  limit: number,
): PayeeSearchResult => {
  const q = query.trim().toLowerCase();
  const all = payees
    .filter((p) => !p.deleted && p.name.toLowerCase().includes(q))
    .sort((a, b) => {
      // Tighter matches first (shorter name = closer to the query),
      // then alphabetical for stability.
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    });
  return {
    matches: all.slice(0, limit).map((p) => ({
      id: p.id,
      name: p.name,
      transfer_account_id: p.transfer_account_id,
    })),
    totalMatched: all.length,
    cap: limit,
  };
};

// ---- Render (pure)

export const renderPayeeSearch = (
  result: PayeeSearchResult,
  query: string,
): string => {
  if (!result.matches.length) {
    return `No payees match "${query}".`;
  }
  const header =
    result.totalMatched > result.cap
      ? `## Payees matching "${query}" (showing ${result.matches.length} of ${result.totalMatched})`
      : `## Payees matching "${query}" (${result.totalMatched})`;
  const lines = result.matches.map((m) => {
    const transferNote = m.transfer_account_id ? " (transfer)" : "";
    return `- ${m.name}${transferNote} — id ${m.id}`;
  });
  return [header, ...lines].join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Search payees by substring match on name. Use this to canonicalize a " +
  "payee before passing it to update_transactions — pass the returned `id` " +
  "as `payee_id` to link to the existing payee instead of risking a new one " +
  "being auto-created from a name string.";

export const registerSearchPayees = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "search_payees",
    {
      title: "Search Payees",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        budget_id: z.string(),
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional().default(20),
      },
      outputSchema: PayeeSearchResultSchema.shape,
    },
    async ({ budget_id, query, limit }) => {
      try {
        const { data } = await getClient().listPayees(budget_id);
        const searchResult = computePayeeSearch(data.payees, query, limit);
        return result(renderPayeeSearch(searchResult, query), searchResult);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
