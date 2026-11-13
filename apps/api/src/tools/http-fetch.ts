import { z } from "zod";
import { defineTool } from "./sdk.js";
import { checkUrl, defaultPolicy, safeFetch, EgressDenied } from "../security/egress.js";

export const httpFetch = defineTool({
  name: "http.fetch",
  version: "1.1.0",
  description: "GET a URL over HTTPS with egress policy. Returns status, content-type and a text slice.",
  input: z.object({ url: z.string().url(), maxBytes: z.number().int().positive().max(2_000_000).optional() }),
  output: z.object({ status: z.number(), url: z.string(), contentType: z.string().nullable(), bytes: z.number(), text: z.string() }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["http:read"], agents: ["browser", "data", "verifier", "synthesizer"],
  timeoutMs: 8_000, maxRetries: 1,
  idempotency: { strategy: "args_hash", ttlSeconds: 300, onConflict: "return_cached" },
  async execute({ url, maxBytes }) {
    try {
      const { response, finalUrl } = await safeFetch(url, defaultPolicy);
      const text = await response.text();
      const slice = text.slice(0, maxBytes ?? 8000);
      return {
        data: {
          status: response.status, url: finalUrl,
          contentType: response.headers.get("content-type"),
          bytes: text.length, text: slice,
        },
      };
    } catch (e) {
      if (e instanceof EgressDenied) throw new Error(`POLICY_DENIED: ${e.message}`);
      throw e;
    }
  },
  async simulate({ url }) {
    const decision = checkUrl(url, defaultPolicy);
    return { data: { simulated: true, url, wouldAllow: decision.ok, reason: decision.ok ? undefined : decision.reason } };
  },
});
