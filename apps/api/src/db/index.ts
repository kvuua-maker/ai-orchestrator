import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

export interface Db {
  readonly driver: "pglite" | "pg";
  query: QueryFn;
  exec(sql: string): Promise<void>;
  /** Транзакція з RLS-контекстом тенанта на ОДНОМУ з'єднанні (§7.2.1). */
  tx<T>(tenantId: string, fn: (q: QueryFn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, "schema.sql"), "utf8");

export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;

  if (url && url.startsWith("postgres")) {
    const pg: any = await import("pg").then((m: any) => m.default ?? m);
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
    return {
      driver: "pg",
      query: (sql, params) => pool.query(sql, params),
      exec: async (sql) => { await pool.query(sql); },
      async tx(tenantId, fn) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
          const out = await fn((sql: string, params?: unknown[]) => c.query(sql, params));
          await c.query("COMMIT");
          return out;
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      async close() { await pool.end(); },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const client: any = new PGlite();
  await client.waitReady;
  const q: QueryFn = async (sql, params = []) => ({ rows: (await client.query(sql, params)).rows ?? [] });
  const db: Db = {
    driver: "pglite",
    query: q,
    exec: async (sql) => { await client.exec(sql); },
    async tx(tenantId, fn) {
      await client.exec("BEGIN");
      try {
        await q("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const out = await fn(q);
        await client.exec("COMMIT");
        return out;
      } catch (e) {
        await client.exec("ROLLBACK").catch(() => {});
        throw e;
      }
    },
    async close() { await client.close(); },
  };
  await db.exec(SCHEMA);
  return db;
}

export async function seed(db: Db): Promise<void> {
  await db.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", ["tnt_demo0001", "Demo"]);
  await db.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", ["tnt_other001", "Other"]);
  await db.query("INSERT INTO users (id, tenant_id, email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    ["usr_demo0001", "tnt_demo0001", "demo@example.com"]);
}
