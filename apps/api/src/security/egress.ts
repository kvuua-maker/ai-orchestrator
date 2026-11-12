import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface EgressPolicy {
  /** Порожній список = дозволено все (крім приватних мереж). */
  allowedDomains?: string[];
  deniedDomains?: string[];
  blockPrivate: boolean;
  allowHttp: boolean;
  maxRedirects: number;
  timeoutMs: number;
}

export const defaultPolicy: EgressPolicy = {
  blockPrivate: true, allowHttp: false, maxRedirects: 3, timeoutMs: 10_000,
};

export type EgressDecision = { ok: true; ips: string[] } | { ok: false; reason: EgressReason; detail?: string };
export type EgressReason = "bad_scheme" | "denied_domain" | "not_allowed" | "private_ip" | "blocked_ip" | "dns_failure" | "too_many_redirects";

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const BLOCKED_HOSTS = [/^localhost$/i, /\.local$/i, /\.internal$/i, /metadata\.google\.internal$/i];

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return PRIVATE_V4.some((re) => re.test(ip));
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true;       // unique local
    if (low.startsWith("fe80")) return true;                              // link-local
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));      // v4-mapped
    return false;
  }
  return true; // не IP — вважаємо підозрілим
}

function domainMatch(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  return p.startsWith("*.") ? h.endsWith(p.slice(1)) || h === p.slice(2) : h === p;
}

/** Перевірка URL без мережі (швидка, для політики доменів). */
export function checkUrl(raw: string, policy: EgressPolicy = defaultPolicy): EgressDecision {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "bad_scheme", detail: "invalid url" }; }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    return { ok: false, reason: "bad_scheme", detail: url.protocol };
  }
  const host = url.hostname;
  if (BLOCKED_HOSTS.some((re) => re.test(host))) return { ok: false, reason: "blocked_ip", detail: host };
  if (policy.deniedDomains?.some((d) => domainMatch(host, d))) return { ok: false, reason: "denied_domain", detail: host };
  if (policy.allowedDomains?.length && !policy.allowedDomains.some((d) => domainMatch(host, d))) {
    return { ok: false, reason: "not_allowed", detail: host };
  }
  if (isIP(host) && policy.blockPrivate && isPrivateIp(host)) return { ok: false, reason: "private_ip", detail: host };
  return { ok: true, ips: [] };
}

/**
 * Повна перевірка з DNS: резолвимо ВСІ адреси до з'єднання (§5.3.3).
 * Захист від DNS rebinding: якщо хоч одна адреса приватна — відмова.
 */
export async function resolveAndCheck(raw: string, policy: EgressPolicy = defaultPolicy): Promise<EgressDecision> {
  const base = checkUrl(raw, policy);
  if (!base.ok) return base;
  const url = new URL(raw);
  if (isIP(url.hostname)) return { ok: true, ips: [url.hostname] };
  try {
    const addrs = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addrs.length) return { ok: false, reason: "dns_failure", detail: "no A/AAAA" };
    const ips = addrs.map((a) => a.address);
    if (policy.blockPrivate) {
      const bad = ips.find(isPrivateIp);
      if (bad) return { ok: false, reason: "private_ip", detail: bad };
    }
    return { ok: true, ips };
  } catch (e) {
    return { ok: false, reason: "dns_failure", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** fetch із політикою та ручним контролем редіректів (кожен стрибок перевіряється). */
export async function safeFetch(raw: string, policy: EgressPolicy = defaultPolicy, init: RequestInit = {}) {
  let current = raw;
  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    const decision = await resolveAndCheck(current, policy);
    if (!decision.ok) throw new EgressDenied(decision.reason, current, decision.detail);
    const res = await fetch(current, { ...init, redirect: "manual", signal: AbortSignal.timeout(policy.timeoutMs) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).toString(); continue; }
    return { response: res, finalUrl: current, ips: decision.ips };
  }
  throw new EgressDenied("too_many_redirects", current);
}

export class EgressDenied extends Error {
  constructor(readonly reason: EgressReason, readonly url: string, readonly detail?: string) {
    super(`egress denied (${reason}): ${url}${detail ? ` — ${detail}` : ""}`);
    this.name = "EgressDenied";
  }
}
