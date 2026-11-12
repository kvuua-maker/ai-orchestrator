import type { ToolDefinition, ToolResult } from "@aio/shared";

const BLOCKED = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^localhost$/i, /^\[::1\]$/];

export function isBlockedHost(hostname: string): boolean {
  return BLOCKED.some((re) => re.test(hostname));
}

export const httpFetchTool: ToolDefinition & {
  execute: (args: { url: string }) => Promise<ToolResult>;
} = {
  name: "http.fetch", version: "1.0.0",
  description: "GET a URL over HTTP. Returns status, content-type and a text slice.",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  outputSchema: { type: "object" },
  risk: "read", effectClass: "pure", costClass: "free",
  requiresApproval: false, requiredScopes: ["http:read"], allowedAgents: ["browser", "data", "verifier"],
  timeoutMs: 10_000, maxRetries: 2, supportsDryRun: true,
  idempotency: { strategy: "args_hash", ttlSeconds: 300, onConflict: "return_cached" },
  async execute({ url }) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, error: { code: "VALIDATION", message: "invalid url", retryable: false } }; }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, error: { code: "POLICY_DENIED", message: "only http/https", retryable: false } };
    }
    if (isBlockedHost(parsed.hostname)) {
      return { ok: false, error: { code: "POLICY_DENIED", message: "private network blocked (SSRF guard)", retryable: false } };
    }
    try {
      const res = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      return {
        ok: true, costMicros: 0, cached: false, dryRun: false,
        data: { status: res.status, url: res.url, contentType: res.headers.get("content-type"), bytes: text.length, text: text.slice(0, 4000) },
        evidence: [{ url: res.url, quote: text.slice(0, 200), capturedAt: new Date().toISOString() }],
        artifacts: [],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: "UPSTREAM_ERROR", message: msg, retryable: true, escalateTo: "next_tier" } };
    }
  },
};
