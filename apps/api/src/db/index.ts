import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly driver: "pglite" | "pg";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, "schema.sql"), "utf8");

/** PGlite — справжній Postgres у WASM: dev/test без сервера (§33). */
class PgliteDb implements Db {
  readonly driver = "pglite" as const;
  constructor(private client: any) {}
  async query<T>(sql: string, params: unknown[] = []) {
    const res = await this.client.query(sql, params);
    return { rows: (res.rows ?? []) as T[] };
  }
  async exec(sql: string) { await this.client.exec(sql); }
  async close() { await this.client.close(); }
}

export async function createDb(opts: { memory?: boolean } = {}): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith("postgres")) {
    const pg: any = await import("pg").then((m: any) => m.default ?? m);
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    return {
      driver: "pg",
      async query<T>(sql: string, params: unknown[] = []) {
        return { rows: (await pool.query(sql, params)).rows as T[] };
      },
      async exec(sql: string) { await pool.query(sql); },
      async close() { await pool.end(); },
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const client = opts.memory === false ? new PGlite("memory://") : new PGlite();
  await client.waitReady;
  const db = new PgliteDb(client);
  await db.exec(SCHEMA);
  return db;
}

/** Транзакція з RLS-контекстом тенанта (§7.2.1). */
export async function withTenant<T>(db: Db, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

export async function seed(db: Db): Promise<void> {
  await db.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", ["tnt_demo0001", "Demo"]);
  await db.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", ["tnt_other001", "Other"]);
  await db.query("INSERT INTO users (id, tenant_id, email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    ["usr_demo0001", "tnt_demo0001", "demo@example.com"]);
}
