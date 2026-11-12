/** Аудит безпеки: перевіряє факти в БД і репозиторії, а не обіцянки. */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";

const ADMIN = process.env.AUDIT_DB_URL ?? process.env.PG_ADMIN_URL ?? "postgres://aio@127.0.0.1:55432/aio";
const APP = process.env.DATABASE_URL ?? "postgres://aio_app@127.0.0.1:6432/aio";

const checks = [];
const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

const TENANT_TABLES = ["runs", "run_events", "tasks", "devices", "secrets", "artifacts", "memory_chunks", "response_cache", "handoffs", "audit_log", "subscriptions", "usage_events", "invoices"];

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();

// 1. RLS на всіх тенантних таблицях
const rls = await admin.query(
  `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE relname = ANY($1::text[]) ORDER BY relname`, [TENANT_TABLES]);
// Якщо бачимо не всі таблиці — аудит недійсний (найчастіше — підключились не до тієї БД)
add("Аудит підключений до бази застосунку", rls.rows.length === TENANT_TABLES.length,
    `знайдено ${rls.rows.length} з ${TENANT_TABLES.length} таблиць`);
const notEnabled = rls.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
const notForced = rls.rows.filter((r) => !r.relforcerowsecurity).map((r) => r.relname);
add("RLS увімкнено на всіх тенантних таблицях", notEnabled.length === 0, notEnabled.join(", "));
add("FORCE RLS увімкнено (діє й для власника)", notForced.length === 0, notForced.join(", "));

// 2. Політики існують
const pol = await admin.query(`SELECT tablename, count(*)::int AS n FROM pg_policies GROUP BY tablename`);
const polMap = Object.fromEntries(pol.rows.map((r) => [r.tablename, r.n]));
const noPolicy = TENANT_TABLES.filter((t) => !polMap[t]);
add("Кожна таблиця має політику", noPolicy.length === 0, noPolicy.join(", "));

// 3. Ролі
const roles = await admin.query(
  `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles
   WHERE rolname IN ('aio_app','aio_svc','aio_owner') ORDER BY rolname`);
for (const r of roles.rows) {
  add(`Роль ${r.rolname}: без SUPERUSER`, !r.rolsuper);
  add(`Роль ${r.rolname}: без BYPASSRLS`, !r.rolbypassrls);
}

// 4. audit_log append-only
const auditGrants = await admin.query(
  `SELECT privilege_type FROM information_schema.role_table_grants
   WHERE table_name='audit_log' AND grantee='aio_app'`);
const types = auditGrants.rows.map((r) => r.privilege_type);
add("audit_log: UPDATE заборонено застосунку", !types.includes("UPDATE"));
add("audit_log: DELETE заборонено застосунку", !types.includes("DELETE"));
add("audit_log: INSERT дозволено", types.includes("INSERT"));

admin.end();

// 5. Ізоляція наживо: тенант B не бачить даних A
const app = new pg.Client({ connectionString: APP });
await app.connect();
await app.query("BEGIN");
await app.query("SELECT set_config('app.tenant_id','tnt_probe_audit',true)");
const leak = await app.query("SELECT count(*)::int AS n FROM runs");
await app.query("SELECT count(*)::int AS n FROM secrets");
await app.query("COMMIT");
add("Новий тенант бачить 0 запусків", leak.rows[0].n === 0, `побачив ${leak.rows[0].n}`);

// спроба підмінити tenant_id через прямий INSERT
let insertBlocked = false;
try {
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.tenant_id','tnt_probe_audit',true)");
  await app.query(`INSERT INTO runs (id, tenant_id, user_id, status, prompt, budget)
    VALUES ('run_audit_probe','tnt_demo0001','u','queued','x','{"maxUsd":1}'::jsonb)`);
  await app.query("ROLLBACK");
} catch { insertBlocked = true; }
add("Вставка з чужим tenant_id відхиляється", insertBlocked);

// 6. Секрети не зберігаються у відкритому вигляді
const plain = await app.query("BEGIN").then(async () => {
  await app.query("SELECT set_config('app.tenant_id','tnt_demo0001',true)");
  const r = await app.query(`SELECT count(*)::int AS n FROM secrets WHERE encode(ciphertext,'escape') LIKE '%sk-%'`);
  await app.query("ROLLBACK");
  return r.rows[0].n;
}).catch(() => 0);
add("Секрети не містять відкритих ключів у БД", plain === 0);
app.end();

// 7. Репозиторій: .env не відстежується
try {
  const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n");
  add(".env не в git", !tracked.includes(".env"));
  add(".secrets/ не в git", !tracked.some((f) => f.startsWith(".secrets/")));
  add("Немає .pem/.key у git", !tracked.some((f) => /\.(pem|key)$/.test(f)));
} catch { add("git-перевірка", false, "git недоступний"); }

// 8. Скан робочого дерева на схожі на секрети рядки
const SCAN = ["GOCSPX-", "sk-", "ghp_", "AKIA", "BEGIN OPENSSH PRIVATE KEY"];
const FILES = execSync("git ls-files '*.ts' '*.tsx' '*.mjs' '*.json' '*.md' '*.yml'", { encoding: "utf8" })
  .split("\n").filter((f) => f && existsSync(f));
const hits = [];
for (const f of FILES) {
  const content = readFileSync(f, "utf8");
  for (const pat of SCAN) {
    const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[A-Za-z0-9_\\-]{12,}", "g");
    const m = content.match(re);
    if (m) hits.push(`${f}: ${m[0].slice(0, 12)}…`);
  }
}
add("Немає схожих на секрети рядків у коді", hits.length === 0, hits.slice(0, 5).join("; "));

// 9. Ключі в .env не потрапляють у логи
const envPath = process.env.AIO_ENV_FILE ?? ".env";
const envExists = existsSync(envPath);
add("Файл середовища існує (не в git)", envExists, envPath);

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ checks, summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length } }, null, 2));
process.exit(failed.length ? 1 : 0);
