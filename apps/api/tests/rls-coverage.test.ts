import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type Db } from "../src/db/index.js";

const TENANT_TABLES = [
  "runs", "run_events", "tasks", "devices", "secrets", "artifacts",
  "memory_chunks", "response_cache", "handoffs", "audit_log",
  "subscriptions", "usage_events", "invoices",
];

let db: Db;
beforeAll(async () => { db = await createDb(); });
afterAll(async () => { await db.close(); });

describe("Покриття RLS (регресійний захист)", () => {
  it("кожна тенантна таблиця має ENABLE + FORCE RLS", async () => {
    const { rows } = await db.query<any>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($1::text[])`, [TENANT_TABLES]);
    expect(rows).toHaveLength(TENANT_TABLES.length);
    const broken = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname);
    expect(broken, `без RLS: ${broken.join(", ")}`).toEqual([]);
  });

  it("кожна таблиця має хоча б одну політику", async () => {
    const { rows } = await db.query<any>(
      "SELECT tablename, count(*)::int AS n FROM pg_policies GROUP BY tablename");
    const map = Object.fromEntries(rows.map((r) => [r.tablename, r.n]));
    const missing = TENANT_TABLES.filter((t) => !map[t]);
    expect(missing, `без політик: ${missing.join(", ")}`).toEqual([]);
  });

  it("роль застосунку не має BYPASSRLS", async () => {
    const { rows } = await db.query<any>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user");
    expect(rows[0].rolbypassrls).toBe(false);
    expect(rows[0].rolsuper).toBe(false);
  });
});
