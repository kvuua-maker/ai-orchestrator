import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { getQuota, getUsage, recordUsage, createInvoice, setPlan, listPlans } from "../src/billing/index.js";

const T = "tnt_other001";
const H = { "x-tenant-id": T };

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp(); await app.ready();
  await app.db.tx(T, async (q) => {
    await q("DELETE FROM usage_events WHERE tenant_id=$1", [T]);
    await q("DELETE FROM subscriptions WHERE tenant_id=$1", [T]);
    await q("DELETE FROM invoices WHERE tenant_id=$1", [T]);
  });
});
afterAll(async () => { await app.close(); });

describe("Білінг: квоти", () => {
  it("без підписки діє free-план", async () => {
    const q = await app.db.tx(T, (tx) => getQuota(tx, T));
    expect(q.plan.id).toBe("free");
    expect(q.allowed).toBe(true);
    expect(q.runsRemaining).toBe(100);
  });

  it("usage зростає після run", async () => {
    await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "білінг" } });
    await app.engine.drain();
    const usage = await app.db.tx(T, (tx) => getUsage(tx, T));
    expect(usage.runs).toBeGreaterThanOrEqual(1);
  });

  it("вичерпана квота → 402 з деталями", async () => {
    await app.db.tx(T, async (q) => {
      await q(`INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1,'free','active')
               ON CONFLICT (tenant_id) DO UPDATE SET plan_id='free', status='active'`, [T]);
      for (let i = 0; i < 100; i++) await recordUsage(q, { tenantId: T, kind: "run", quantity: 1 });
    });
    const r = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "ще один" } });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe("QUOTA_EXCEEDED");
    expect(r.json().error.details.runsRemaining).toBe(0);
  });

  it("після зміни плану квота знову доступна", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/billing/plan", headers: H, payload: { planId: "pro" } });
    expect(r.statusCode).toBe(200);
    const q = await app.db.tx(T, (tx) => getQuota(tx, T));
    expect(q.plan.id).toBe("pro");
    expect(q.allowed).toBe(true);
  });

  it("невідомий план → 404", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/billing/plan", headers: H, payload: { planId: "enterprise-999" } });
    expect(r.statusCode).toBe(404);
  });

  it("квоти ізольовані між тенантами", async () => {
    const other = await app.db.tx("tnt_demo0001", (tx) => getQuota(tx, "tnt_demo0001"));
    const mine = await app.db.tx(T, (tx) => getQuota(tx, T));
    expect(mine.usage.runs).not.toBe(other.usage.runs);
  });
});

describe("Білінг: інвойси", () => {
  it("інвойс включає підписку й перевитрату токенів", async () => {
    const inv = await app.db.tx(T, async (q) => {
      await setPlan(q, T, "free");
      await q("DELETE FROM usage_events WHERE tenant_id=$1", [T]);
      await recordUsage(q, { tenantId: T, kind: "tokens", quantity: 150_000 });   // free: 100k включено
      await q("UPDATE plans SET overage_per_1k_tokens=0.02 WHERE id='free'");
      const invoice = await createInvoice(q, T);
      await q("DELETE FROM invoices WHERE id=$1", [invoice.id]);
      return invoice;
    });
    expect(inv.usage.tokens).toBe(150_000);
    expect(inv.amountUsd).toBeGreaterThan(0);
    expect(inv.lines.length).toBe(2);              // план + перевитрата
    expect(inv.lines[1].description).toContain("overage");
    expect(inv.amountUsd).toBeCloseTo(50 * 0.02, 2);   // 50k понаднормових * $0.02/1k = $1
  });

  it("без перевитрати — лише рядок плану", async () => {
    const inv = await app.db.tx(T, async (q) => {
      await q("DELETE FROM usage_events WHERE tenant_id=$1", [T]);
      await recordUsage(q, { tenantId: T, kind: "tokens", quantity: 1_000 });
      return createInvoice(q, T);
    });
    expect(inv.lines).toHaveLength(1);
    expect(Number(inv.amountUsd)).toBe(0);
  });

  it("POST /v1/billing/invoices створює інвойс і аудит", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/billing/invoices", headers: H, payload: {} });
    expect(r.statusCode).toBe(201);
    expect(r.json().invoice.id).toMatch(/^inv_/);
    const a = await app.inject({ method: "GET", url: "/v1/audit?action=invoice.created", headers: H });
    expect(a.json().items.length).toBeGreaterThan(0);
  });

  it("GET /v1/billing/usage повертає план і використання", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/billing/usage", headers: H });
    const b = r.json();
    expect(b.quota.plan.id).toBe("free");
    expect(b.usage.periodStart).toBeTruthy();
  });

  it("список планів доступний", async () => {
    const plans = await app.db.tx(T, (q) => listPlans(q));
    expect(plans.map((p) => p.id)).toEqual(["free", "pro", "business"]);
  });

  it("інвойси одного тенанта невидимі іншому", async () => {
    await app.inject({ method: "POST", url: "/v1/billing/invoices", headers: H, payload: {} });
    const mine = await app.inject({ method: "GET", url: "/v1/billing/invoices", headers: H });
    const other = await app.inject({ method: "GET", url: "/v1/billing/invoices", headers: { "x-tenant-id": "tnt_demo0001" } });
    const otherIds = new Set(other.json().items.map((i: any) => i.id));
    expect(mine.json().items.every((i: any) => !otherIds.has(i.id))).toBe(true);
  });
});
