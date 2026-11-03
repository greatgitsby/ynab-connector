import { z } from "zod";
import { planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Payee, YnabClient } from "../ynab";
import { YnabError } from "../ynab";
import { handleError, result, scopeDeniedError } from "../format";
import type { Props } from "../ynab-auth";

// ---- Result type

const RenameResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    payee_id: z.string(),
    before_name: z.string(),
    after_name: z.string(),
  }),
  z.object({ ok: z.literal(false), payee_id: z.string(), error: z.string() }),
]);
export type RenameResult = z.infer<typeof RenameResultSchema>;

export const RenamePayeesResultSchema = z.object({
  results: z.array(RenameResultSchema),
});
export type RenamePayeesResult = z.infer<typeof RenamePayeesResultSchema>;

export interface RenameInput {
  payee_id: string;
  name: string;
}

// ---- Compute (pure): why a rename must not be sent, or null

export const renameRefusal = (
  input: RenameInput,
  payees: Payee[],
): string | null => {
  const payee = payees.find((p) => p.id === input.payee_id && !p.deleted);
  if (!payee) return "No such payee.";
  if (payee.transfer_account_id) {
    return "Transfer payees take their name from the account; rename the account in YNAB instead.";
  }
  const name = input.name.trim().toLowerCase();
  const taken = payees.find(
    (p) => !p.deleted && p.id !== payee.id && p.name.trim().toLowerCase() === name,
  );
  // Two payees with one name can't be told apart in YNAB.
  if (taken) {
    return `Payee "${taken.name}" (id ${taken.id}) already has that name; use merge_payees to combine them.`;
  }
  return null;
};

// ---- Effectful: one PATCH per rename, in input order, never short-circuit

const errorMessage = (e: unknown) =>
  e instanceof YnabError
    ? `YNAB ${e.status}: ${e.body}`
    : e instanceof Error
      ? e.message
      : String(e);

export const applyRenamePayees = async (
  client: YnabClient,
  planId: string,
  renames: RenameInput[],
): Promise<RenamePayeesResult> => {
  const { data } = await client.listPayees(planId);
  const payees = [...data.payees];
  const results: RenameResult[] = [];
  for (const input of renames) {
    const refusal = renameRefusal(input, payees);
    if (refusal) {
      results.push({ ok: false, payee_id: input.payee_id, error: refusal });
      continue;
    }
    const i = payees.findIndex((p) => p.id === input.payee_id);
    try {
      const updated = await client.updatePayee(planId, input.payee_id, {
        name: input.name.trim(),
      });
      results.push({
        ok: true,
        payee_id: input.payee_id,
        before_name: payees[i].name,
        after_name: updated.data.payee.name,
      });
      // Later renames in the batch check against the new name.
      payees[i] = updated.data.payee;
    } catch (e) {
      results.push({ ok: false, payee_id: input.payee_id, error: errorMessage(e) });
    }
  }
  return { results };
};

// ---- Render (pure)

export const renderRenamePayeesResult = (out: RenamePayeesResult): string => {
  const okCount = out.results.filter((r) => r.ok).length;
  const errCount = out.results.length - okCount;
  const header = `## Renamed ${okCount} / ${out.results.length} payee${out.results.length === 1 ? "" : "s"}${errCount ? ` (${errCount} error${errCount === 1 ? "" : "s"})` : ""}`;
  const lines = out.results.map((r) =>
    r.ok
      ? `- [ok] "${r.before_name}" → "${r.after_name}" — id ${r.payee_id}`
      : `- [error] payee ${r.payee_id}: ${r.error}`,
  );
  return [header, ...lines].join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Rename one or more payees. Every transaction on a payee shows the new " +
  "name. Find payee ids with list_payees or review_payees. Refuses a name " +
  "another payee already has (use merge_payees to combine them) and " +
  "transfer payees, which are named after their account. A failed rename " +
  "doesn't stop the rest, and the response reports each one. Requires " +
  "write access; a read-only connection must be reconnected to use this tool.";

export const registerRenamePayees = (
  server: McpServer,
  getClient: () => YnabClient,
  getProps: () => Props,
) => {
  server.registerTool(
    "rename_payees",
    {
      title: "Rename Payees",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        plan_id: planIdParam,
        renames: z
          .array(
            z.object({
              payee_id: z.string(),
              name: z.string().trim().min(1).max(500),
            }),
          )
          .min(1),
      },
    },
    async ({ plan_id, renames }) => {
      if (!getProps().canWrite) return scopeDeniedError();
      try {
        const out = await applyRenamePayees(getClient(), plan_id, renames);
        return result(renderRenamePayeesResult(out), out);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
