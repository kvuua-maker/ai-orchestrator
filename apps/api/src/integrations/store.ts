import crypto from "node:crypto";
import type { QueryFn } from "../db/index.js";

/** Підключення зовнішніх сервісів: ключі зберігаються зашифрованими (AES-256-GCM). */

const masterKey = () => crypto.createHash("sha256").update(process.env.VAULT_MASTER_KEY ?? "dev-master-key").digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string | null {
  try {
    const [ivB, tagB, dataB] = payload.split(".");
    if (!ivB || !tagB || !dataB) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(dataB, "base64")), d.final()]).toString("utf8");
  } catch { return null; }
}

export interface Provider {
  id: string; name: string; what: string; env: string;
  placeholder: string; docs: string; freeTier: string;
}

export const PROVIDERS: Provider[] = [
  { id: "groq", name: "Groq — розпізнавання мовлення", what: "whisper-large-v3-turbo: точний голосовий ввід українською",
    env: "GROQ_API_KEY", placeholder: "gsk_...", docs: "https://console.groq.com/keys", freeTier: "безкоштовно ~8 год аудіо/добу" },
  { id: "opendatabot", name: "Opendatabot — нерухомість", what: "власник об'єкта за адресою, обтяження, площа",
    env: "OPENDATABOT_API_KEY", placeholder: "ключ з кабінету Opendatabot", docs: "https://opendatabot.com/apps", freeTier: "безкоштовний тариф" },
  { id: "scanbe", name: "scanbe.io — реєстри", what: "альтернативне джерело даних про нерухомість",
    env: "SCANBE_API_KEY", placeholder: "ключ scanbe.io", docs: "https://scanbe.io/", freeTier: "пробний доступ" },
  { id: "deepseek", name: "DeepSeek — мова", what: "генерація відповідей і виклик інструментів",
    env: "DEEPSEEK_API_KEY", placeholder: "sk-...", docs: "https://platform.deepseek.com/api_keys", freeTier: "платно за токени" },
];

/** Кеш у пам'яті: інструменти читають ключі звідси, без запиту в БД на кожен виклик. */
const cache = new Map<string, string>();

export function cachedKey(provider: string): string | null {
  const fromCache = cache.get(provider);
  if (fromCache) return fromCache;
  const envName = PROVIDERS.find((p) => p.id === provider)?.env;
  const fromEnv = envName ? process.env[envName] : undefined;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

/** Дістати повний ключ (кеш → env). */
export function resolveKey(provider: string): string | null {
  return cachedKey(provider);
}

export async function loadKeys(q: QueryFn): Promise<void> {
  try {
    const { rows } = await q<{ provider: string; secret: string }>(
      "SELECT provider, secret FROM integrations WHERE active = true");
    for (const r of rows) {
      const v = decryptSecret(r.secret);
      if (v) cache.set(r.provider, v);
    }
  } catch { /* таблиці ще немає — працюємо з env */ }
}

export interface IntegrationView {
  id: string; name: string; what: string; docs: string; freeTier: string;
  configured: boolean; masked: string | null; source: "settings" | "env" | null; updatedAt: string | null;
}

export async function listIntegrations(q: QueryFn): Promise<IntegrationView[]> {
  let rows: Array<{ provider: string; secret: string; updated_at: string }> = [];
  try { rows = (await q<{ provider: string; secret: string; updated_at: string }>("SELECT provider, secret, updated_at FROM integrations WHERE active = true")).rows; } catch { rows = []; }
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return PROVIDERS.map((p) => {
    const row = byProvider.get(p.id);
    const fromDb = row ? decryptSecret(row.secret) : null;
    const fromEnv = process.env[p.env];
    const key = fromDb ?? (fromEnv && fromEnv.trim() ? fromEnv.trim() : null);
    return {
      id: p.id, name: p.name, what: p.what, docs: p.docs, freeTier: p.freeTier,
      configured: Boolean(key),
      masked: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
      source: fromDb ? "settings" : key ? "env" : null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function saveKey(q: QueryFn, tenantId: string, provider: string, secret: string): Promise<void> {
  const enc = encryptSecret(secret.trim());
  await q(
    `INSERT INTO integrations (tenant_id, provider, secret, active, updated_at)
     VALUES ($1,$2,$3,true,now())
     ON CONFLICT (tenant_id, provider) DO UPDATE SET secret=$3, active=true, updated_at=now()`,
    [tenantId, provider, enc]);
  cache.set(provider, secret.trim());
}

export async function removeKey(q: QueryFn, tenantId: string, provider: string): Promise<void> {
  await q("UPDATE integrations SET active=false, updated_at=now() WHERE tenant_id=$1 AND provider=$2", [tenantId, provider]);
  cache.delete(provider);
}

/** Перевірка ключа реальним запитом до провайдера. */
export async function testKey(provider: string, secret: string): Promise<{ ok: boolean; message: string; ms: number }> {
  const t0 = Date.now();
  try {
    if (provider === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) });
      return { ok: res.ok, message: res.ok ? "Groq відповідає, ключ дійсний" : `Groq повернув ${res.status}`, ms: Date.now() - t0 };
    }
    if (provider === "opendatabot") {
      const res = await fetch(`https://api.opendatabot.com/api/v3/company/33882357?apiKey=${encodeURIComponent(secret)}`, { signal: AbortSignal.timeout(10_000) });
      return { ok: res.ok, message: res.ok ? "Opendatabot відповідає" : `Opendatabot повернув ${res.status}`, ms: Date.now() - t0 };
    }
    if (provider === "scanbe") {
      const res = await fetch("https://scanbe.io/", { signal: AbortSignal.timeout(10_000) });
      return { ok: res.ok, message: res.ok ? "scanbe.io доступний (перевірте ключ у кабінеті)" : `scanbe повернув ${res.status}`, ms: Date.now() - t0 };
    }
    if (provider === "deepseek") {
      const res = await fetch("https://api.deepseek.com/models", { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) });
      return { ok: res.ok, message: res.ok ? "DeepSeek відповідає" : `DeepSeek повернув ${res.status}`, ms: Date.now() - t0 };
    }
    return { ok: false, message: "невідомий провайдер", ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, message: `помилка з'єднання: ${e?.message ?? e}`, ms: Date.now() - t0 };
  }
}
