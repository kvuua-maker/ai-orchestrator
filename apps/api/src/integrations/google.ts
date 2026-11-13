import pg from "pg";
import { encryptSecret, decryptSecret } from "./store.js";
import type { QueryFn } from "../db/index.js";

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.EDR_DATABASE_URL ?? process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30_000 });
  return pool;
}

/** Виконати запит з tenant-контекстом (RLS), повернувши результат. */
async function withTenant<T>(tenantId: string, fn: (q: QueryFn) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const q = ((sql: string, params?: unknown[]) => client.query(sql, params)) as unknown as QueryFn;
    const out = await fn(q);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Google OAuth (Drive + Gmail). Токени зберігаються зашифрованими в integrations. */

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "openid", "email",
];

const cfg = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  redirect: process.env.GOOGLE_REDIRECT_URI ?? "",
});

export function googleConfigured(): boolean {
  const c = cfg();
  return Boolean(c.clientId && c.clientSecret && c.redirect);
}

export function authUrl(state: string): string {
  const c = cfg();
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

interface Tokens { access_token: string; refresh_token?: string; expires_at: number; email?: string }

export async function exchangeCode(code: string): Promise<Tokens> {
  const c = cfg();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: c.clientId, client_secret: c.clientSecret,
      redirect_uri: c.redirect, grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  let email: string | undefined;
  try {
    const me = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${j.access_token}` } });
    email = (await me.json())?.email;
  } catch { /* не критично */ }
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, email };
}

export async function saveTokensAndStore(tenantId: string, tokens: Tokens): Promise<void> {
  return withTenant(tenantId, (q) => saveTokens(q, tenantId, tokens));
}

export async function saveTokens(q: QueryFn, tenantId: string, tokens: Tokens): Promise<void> {
  const payload = encryptSecret(JSON.stringify(tokens));
  await q(
    `INSERT INTO integrations (tenant_id, provider, secret, active, updated_at)
     VALUES ($1,'google',$2,true,now())
     ON CONFLICT (tenant_id, provider) DO UPDATE SET secret=$2, active=true, updated_at=now()`,
    [tenantId, payload]);
}

export async function loadTokens(q: QueryFn, tenantId: string): Promise<Tokens | null> {
  const { rows } = await q<{ secret: string }>(
    "SELECT secret FROM integrations WHERE tenant_id=$1 AND provider='google' AND active=true", [tenantId]);
  const raw = rows[0]?.secret;
  if (!raw) return null;
  const json = decryptSecret(raw);
  if (!json) return null;
  try { return JSON.parse(json) as Tokens; } catch { return null; }
}

/** Свіжий access token: оновлює через refresh_token, якщо прострочений. */
export async function freshAccessToken(tenantId: string): Promise<string | null> {
  return withTenant(tenantId, (q) => freshAccessTokenIn(q, tenantId));
}

async function freshAccessTokenIn(q: QueryFn, tenantId: string): Promise<string | null> {
  const t = await loadTokens(q, tenantId);
  if (!t) return null;
  if (t.expires_at > Date.now() + 60_000) return t.access_token;
  if (!t.refresh_token) return t.access_token;
  const c = cfg();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId, client_secret: c.clientSecret,
      refresh_token: t.refresh_token, grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return t.access_token;
  const j: any = await res.json();
  const next: Tokens = { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 };
  await saveTokens(q, tenantId, next);
  return next.access_token;
}
