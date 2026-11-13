import { z } from "zod";
import { defineTool, ToolFailure } from "./sdk.js";

/**
 * crm.create_lead — створення ліда в KeyCRM (або сумісній CRM) через REST API.
 * Ключ береться зі сторінки «Підключення» (provider: keycrm) або з KEYCRM_API_KEY.
 */

export const crmCreateLead = defineTool({
  name: "crm.create_lead",
  version: "1.0.0",
  description:
    "Create a lead (order/request) in KeyCRM. Provide the client's name and phone, plus any note, product or amount. " +
    "Requires a KeyCRM API key configured on the Connections page.",
  input: z.object({
    fullName: z.string().min(2).max(120),
    phone: z.string().min(5).max(30).optional(),
    email: z.string().email().optional(),
    note: z.string().max(1000).optional(),
    source: z.string().max(60).optional(),
    amount: z.number().min(0).optional(),
  }),
  output: z.object({ created: z.boolean(), leadId: z.string().nullable(), url: z.string().nullable(), message: z.string() }),
  risk: "write", effectClass: "non_idempotent", costClass: "cheap",
  scopes: ["crm:write"], agents: ["synthesizer", "data"],
  timeoutMs: 20_000, maxRetries: 0,
  async execute(input) {
    const { resolveKey } = await import("../integrations/store.js");
    const key = resolveKey("keycrm") ?? process.env.KEYCRM_API_KEY;
    if (!key) {
      throw new ToolFailure("AUTH", "KeyCRM не підключено: додайте API-ключ на сторінці «Підключення».", false);
    }
    const body = {
      title: `Лід: ${input.fullName}`,
      source_id: null,
      manager_comment: input.note ?? null,
      buyer: {
        full_name: input.fullName,
        phone: input.phone ?? null,
        email: input.email ?? null,
      },
      ...(input.amount ? { grand_total: input.amount } : {}),
    };

    const res = await fetch("https://openapi.keycrm.app/v1/order", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => { throw new ToolFailure("UPSTREAM_ERROR", `KeyCRM недоступний: ${e?.message ?? e}`, true); });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ToolFailure("UPSTREAM_ERROR", `KeyCRM повернув ${res.status}: ${text.slice(0, 200)}`, res.status >= 500);
    }
    const json: any = await res.json().catch(() => ({}));
    const id = json?.id ? String(json.id) : null;
    return {
      data: {
        created: Boolean(id),
        leadId: id,
        url: id ? `https://app.keycrm.tv/order/${id}` : null,
        message: id ? "Ліда створено в KeyCRM" : "KeyCRM не повернув ідентифікатор",
      },
    };
  },
  async simulate() {
    return { data: { created: false, leadId: null, url: null, message: "dry-run" } };
  },
});
