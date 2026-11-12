import { describe, it, expect } from "vitest";
import { checkUrl, resolveAndCheck, isPrivateIp, defaultPolicy, EgressDenied, safeFetch } from "./egress.js";

describe("egress policy", () => {
  it("https дозволено, http — ні (за замовчуванням)", () => {
    expect(checkUrl("https://example.com").ok).toBe(true);
    expect(checkUrl("http://example.com").ok).toBe(false);
  });
  it("приватні IP і localhost блокуються", () => {
    for (const u of ["https://127.0.0.1", "https://10.1.2.3", "https://192.168.1.1", "https://169.254.169.254", "https://localhost"]) {
      expect(checkUrl(u).ok, u).toBe(false);
    }
  });
  it("allowlist працює з wildcard", () => {
    const p = { ...defaultPolicy, allowedDomains: ["*.example.com"] };
    expect(checkUrl("https://api.example.com/x", p).ok).toBe(true);
    expect(checkUrl("https://evil.com", p).ok).toBe(false);
  });
  it("denylist має приоритет", () => {
    const p = { ...defaultPolicy, allowedDomains: ["*.example.com"], deniedDomains: ["bad.example.com"] };
    expect(checkUrl("https://bad.example.com", p).ok).toBe(false);
  });
  it("isPrivateIp: v4, v6, v4-mapped", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
  it("DNS-резолв повертає IP і не падає на публічному домені", async () => {
    const d = await resolveAndCheck("https://example.com");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.ips.length).toBeGreaterThan(0);
  });
  it("safeFetch кидає EgressDenied на приватній адресі", async () => {
    await expect(safeFetch("https://127.0.0.1/secret")).rejects.toBeInstanceOf(EgressDenied);
  });
});
