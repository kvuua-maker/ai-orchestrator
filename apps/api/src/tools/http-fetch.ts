import type { Tool } from "./registry.js";

const BLOCKED = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^localhost$/i, /^\[::1\]$/];
export const isBlockedHost = (h: string) => BLOCKED.some((re) => re.test(h));

export const httpFetch: Tool = {
  definition: {
    name: "http.fetch", version: "1.0.0",
    description: "GET a URL over HTTP. Returns status, content-type and a text slice.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    outputSchema: { type: "object" },
    risk: "read", effectClass: "pure", costClass: "free",
    requiresApproval: false, requiredScopes: ["http:read"],
    allowedAgents: ["browser", "data", "verifier", "synthesizer"],
    timeoutMs: 10_000, maxRetries: 2, supportsDryRun: true,
    idempotency: { strategy: "args_hash", ttlSeconds: 300, onConflict: "return_cached" },
  },
  async execute(args) {
    const raw = String(args.url ?? "");
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, error: { code: "VALIDATION", message: "invalid url", retryable: false } }; }
    if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: { code: "POLICY_DENIED", message: "only http/https", retryable: false } };
    if (isBlockedHost(url.hostname)) return { ok: false, error: { code: "POLICY_DENIED", message: "private network blocked (SSRF guard)", retryable: false } };
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      return {
        ok: true, costMicros: 0, cached: false, dryRun: false,
        data: { status: res.status, url: res.url, contentType: res.headers.get("content-type"), bytes: text.length, text: text.slice(0, 8000) },
        evidence: [{ url: res.url, quote: text.slice(0, 200), capturedAt: new Date().toISOString() }],
        artifacts: [],
      };
    } catch (e) {
      return { ok: false, error: { code: "UPSTREAM_ERROR", message: e instanceof Error ? e.message : String(e), retryable: true, escalateTo: "next_tier" } };
    }
  },
  async simulate(args) {
    return { ok: true, costMicros: 0, cached: false, dryRun: true, data: { simulated: true, url: String(args.url ?? "") }, evidence: [], artifacts: [] };
  },
};
