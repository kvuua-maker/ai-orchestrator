/**
 * Ідемпотентне налаштування GitHub: репозиторій, remote, секрети, push.
 * Потрібен токен із правом створювати репозиторії (Administration: write).
 * Запуск: GH_TOKEN=... node scripts/gh-setup.mjs
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import sodium from "libsodium-wrappers";

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error("GH_TOKEN is required"); process.exit(1); }
const OWNER = process.env.GH_OWNER ?? "kvuua-maker";
const REPO = process.env.GH_REPO ?? "ai-orchestrator";
const API = "https://api.github.com";
const H = { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json" };

const call = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// 1. репозиторій
let { status } = await call(`/repos/${OWNER}/${REPO}`);
if (status === 404) {
  const r = await call("/user/repos", { method: "POST", body: JSON.stringify({ name: REPO, private: true, description: "Universal RPA Agent" }) });
  if (r.status >= 300) { console.error("cannot create repo:", r.status, r.body?.message); process.exit(2); }
  console.log("repo created");
} else console.log("repo exists");

// 2. remote + push
const remote = `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`;
try { execSync("git remote remove origin", { stdio: "ignore" }); } catch {}
execSync(`git remote add origin ${remote}`);
execSync("git push -u origin main --force", { stdio: "inherit" });

// 3. секрети (libsodium sealed box)
const { body: key } = await call(`/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
await sodium.ready;
const enc = (v) => sodium.to_base64(
  sodium.crypto_box_seal(sodium.from_string(v), sodium.from_base64(key.key)),
  sodium.base64_variants.ORIGINAL,
);
const secrets = {
  DEPLOY_SSH_KEY: readFileSync(".secrets/deploy_ed25519", "utf8"),
  DEPLOY_HOST: process.env.DEPLOY_HOST ?? "",
};
for (const [name, value] of Object.entries(secrets)) {
  if (!value) { console.log(`secret ${name} skipped (empty)`); continue; }
  const r = await call(`/repos/${OWNER}/${REPO}/actions/secrets/${name}`, {
    method: "PUT", body: JSON.stringify({ encrypted_value: enc(value), key_id: key.key_id }),
  });
  console.log(r.status === 201 || r.status === 204 ? `secret ${name} set` : `secret ${name} FAILED ${r.status}`);
}

// 4. перевірка пайплайна
await new Promise((r) => setTimeout(r, 8000));
const runs = await call(`/repos/${OWNER}/${REPO}/actions/runs?per_page=1`);
const run = runs.body?.workflow_runs?.[0];
console.log(run ? `workflow: ${run.name} #${run.run_number} status=${run.status} url=${run.html_url}` : "no workflow runs yet");
