#!/usr/bin/env node
/**
 * verify-google-oauth.mjs — ізольована перевірка Google OAuth credentials.
 *
 * Навмисно: нуль залежностей, нуль імпортів із проєкту. Можна видалити після перевірки.
 *
 * Що перевіряє:
 *   T1. Мережа до oauth2.googleapis.com / accounts.google.com
 *   T2. Формат client_id і client_secret
 *   T3. Валідність пари client_id+client_secret (token endpoint)
 *   T4. Чи приймає Google client_id в authorization URL (redirect на consent)
 *
 * Чому не можна отримати access token:
 *   Потік "authorization_code" вимагає code, який видається ЛИШЕ після згоди користувача
 *   в браузері. Без нього жоден серверний виклик токена неможливий.
 *   Але Google розрізняє помилки:
 *     invalid_client → пари не існує / секрет невірний
 *     invalid_grant  → клієнт ВАЛІДНИЙ, невалідний лише code  ← це успіх перевірки
 *
 * Запуск:  node scripts/verify-google-oauth.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env");

// ---------- helpers ----------
const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}✗${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const info = (m) => console.log(`${C.d}  ${m}${C.x}`);

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const mask = (s) => (s.length <= 12 ? "*".repeat(s.length) : `${s.slice(0, 8)}…${s.slice(-4)}`);

// ---------- main ----------
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  (pass ? ok : bad)(`${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`\n${C.b}Google OAuth — перевірка ключів${C.x}\n`);

// T0: читання .env
let env;
try {
  env = loadEnv(ENV_PATH);
} catch {
  console.log(`${C.r}Не знайдено .env${C.x} за шляхом ${ENV_PATH}`);
  process.exit(1);
}

const CLIENT_ID = env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET ?? "";

console.log(`${C.b}T1 · Мережа${C.x}`);
for (const url of ["https://oauth2.googleapis.com/token", "https://accounts.google.com/"]) {
  try {
    const t0 = Date.now();
    const res = await fetch(url, { method: "HEAD", redirect: "manual" });
    record(`reachable ${new URL(url).host}`, true, `HTTP ${res.status}, ${Date.now() - t0} ms`);
  } catch (e) {
    record(`reachable ${new URL(url).host}`, false, e.message);
  }
}

console.log(`\n${C.b}T2 · Формат${C.x}`);
record("client_id присутній", CLIENT_ID.length > 0, mask(CLIENT_ID));
record(
  "client_id формат *.apps.googleusercontent.com",
  /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID),
  CLIENT_ID.split(".").slice(-3).join("."),
);
record("client_secret присутній", CLIENT_SECRET.length > 0, mask(CLIENT_SECRET));
record("client_secret формат GOCSPX-…", CLIENT_SECRET.startsWith("GOCSPX-"), `${CLIENT_SECRET.length} символів`);

console.log(`\n${C.b}T3 · Валідність пари (token endpoint)${C.x}`);

// Навмисно невалідний code: якщо клієнт існує — Google відповість invalid_grant.
const body = new URLSearchParams({
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  grant_type: "authorization_code",
  code: "invalid_test_code_for_verification",
  redirect_uri: "http://localhost:3000/api/auth/callback/google",
});

let tokenVerdict = "unknown";
try {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  const err = json.error ?? "(немає поля error)";

  info(`HTTP ${res.status} · error=${err} · ${json.error_description ?? ""}`);

  switch (err) {
    case "invalid_grant":
      tokenVerdict = "valid";
      record("пара client_id+client_secret валідна", true, "отримано invalid_grant (клієнт існує, code невалідний)");
      break;
    case "invalid_client":
      tokenVerdict = "invalid";
      record("пара client_id+client_secret валідна", false, "invalid_client — секрет невірний або клієнт видалено");
      break;
    case "unauthorized_client":
      tokenVerdict = "partial";
      record("клієнт існує, але grant_type заборонений", true, "unauthorized_client — перевірте тип клієнта в Console");
      break;
    case "redirect_uri_mismatch":
      tokenVerdict = "valid";
      record("клієнт валідний", true, "redirect_uri_mismatch — URI не доданий у Console (очікувано для тесту)");
      break;
    default:
      tokenVerdict = "unknown";
      record("відповідь Google", false, `непередбачена помилка: ${err}`);
  }
} catch (e) {
  record("token endpoint", false, e.message);
}

console.log(`\n${C.b}T4 · Authorization URL${C.x}`);
try {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", "http://localhost:3000/api/auth/callback/google");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  const loc = res.headers.get("location") ?? "";
  info(`HTTP ${res.status}${loc ? ` · location=${loc.slice(0, 80)}` : ""}`);

  // Валідний client_id → 302 на consent. Невалідний → 400/401 зі сторінкою invalid_client.
  if (res.status === 302 || res.status === 303) {
    record("Google приймає client_id", true, "редирект на consent screen");
  } else if (res.status === 400 || res.status === 401) {
    const text = await res.text().catch(() => "");
    const isInvalidClient = /invalid_client|OAuth client was not found/i.test(text);
    record("Google приймає client_id", !isInvalidClient, isInvalidClient ? "invalid_client у відповіді" : `HTTP ${res.status}`);
  } else {
    warn(`несподіваний статус ${res.status}`);
    record("Google приймає client_id", false, `HTTP ${res.status}`);
  }
} catch (e) {
  record("authorization URL", false, e.message);
}

// ---------- verdict ----------
const failed = results.filter((r) => !r.pass);
console.log(`\n${C.b}──────────── РЕЗУЛЬТАТ ────────────${C.x}\n`);

if (failed.length === 0 && tokenVerdict === "valid") {
  console.log(`${C.g}${C.b}КЛЮЧІ ВАЛІДНІ, ЗВ'ЯЗОК Є${C.x}`);
  console.log(`${C.d}Google визнає client_id та client_secret. Access token не отримано —`);
  console.log(`для цього потрібна згода користувача в браузері (redirect flow).${C.x}`);
  process.exit(0);
}

console.log(`${C.r}${C.b}ПОМИЛКА${C.x}`);
console.log(`${C.d}Провалено перевірок: ${failed.length}${C.x}`);
for (const f of failed) console.log(`  ${C.r}✗${C.x} ${f.name}: ${f.detail}`);
process.exit(1);
