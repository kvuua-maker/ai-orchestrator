/** Bootstrap: БД, ролі, FORCE RLS. Запуск: node scripts/db-bootstrap.mjs */
import { readFileSync } from "node:fs";
import pg from "pg";

const admin = process.env.PG_ADMIN_URL ?? "postgres://aio@127.0.0.1:55432/postgres";
const appUrl = process.env.DATABASE_URL ?? "postgres://aio_app@127.0.0.1:55432/aio";

// 1. база
const root = new pg.Client({ connectionString: admin });
await root.connect();
await root.query(`DO $$ BEGIN CREATE ROLE aio_owner LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
await root.query(`DO $$ BEGIN CREATE ROLE aio_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
await root.query("ALTER ROLE aio_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");
const { rows } = await root.query("SELECT 1 FROM pg_database WHERE datname='aio'");
if (!rows.length) await root.query("CREATE DATABASE aio OWNER aio_owner");
await root.end();

// 2. схема від власника
if (!process.env.PG_ADMIN_URL && !process.env.PGHOST) {
  console.error("PG_ADMIN_URL (або PGHOST/PGUSER/PGPASSWORD) не заданий");
  process.exit(2);
}
const dbUrl = new URL(admin);
dbUrl.pathname = "/aio";                       // НЕ string.replace: він плутає user з db
const db = new pg.Client({ connectionString: dbUrl.toString() });
await db.connect();
await db.query(readFileSync(new URL("../apps/api/src/db/schema.sql", import.meta.url), "utf8"));
await db.query(readFileSync(new URL("../apps/api/src/db/rls.sql", import.meta.url), "utf8"));
const appPw = process.env.AIO_APP_PASSWORD;
if (appPw) await db.query(`ALTER ROLE aio_app WITH PASSWORD ${db.escapeLiteral(appPw)}`);
const svcPw = process.env.AIO_SVC_PASSWORD;
if (svcPw) await db.query(`ALTER ROLE aio_svc WITH PASSWORD ${db.escapeLiteral(svcPw)}`);
await db.end();

// 3. перевірка з ролі застосунку
const app = new pg.Client({ connectionString: appUrl });
await app.connect();
await app.query("BEGIN");
await app.query("SELECT set_config('app.tenant_id','tnt_demo0001',true)");
const cnt = await app.query("SELECT count(*)::int AS n FROM runs");
await app.query("COMMIT");
const forced = await app.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('runs','run_events','tasks','devices','secrets') ORDER BY relname");
console.log("admin:", `${dbUrl.host}${dbUrl.pathname}`);
console.log("app role sees runs:", cnt.rows[0].n);
console.log(forced.rows);
await app.end();
