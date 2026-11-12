import Fastify, { type FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import {
  CreateRunRequest, IDEMPOTENCY_HEADER, MetaResponse, PresignRequest, RegisterDeviceRequest,
  API_VERSION, MIN_APP_VERSION, type RunView, type RunListItem,
} from "@aio/shared";
import { createDb, seed, type Db, type QueryFn } from "./db/index.js";
import { createEngine, type Engine } from "./engine/executor.js";
import { appendEvent, getEvents, getRun, insertRun, listRuns, setStatus } from "./repo/runs.js";
import { newId } from "./ids.js";
import { createArtifactStore } from "./artifacts/store.js";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_TENANT = "tnt_demo0001";
const DEFAULT_USER = "usr_demo0001";

function encryptSecret(plain: string) {
  const key = crypto.createHash("sha256").update(process.env.VAULT_MASTER_KEY ?? "dev-master-key").digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { ciphertext: ct, iv, tag: c.getAuthTag(), fingerprint: crypto.createHmac("sha256", key).update(plain).digest("hex").slice(0, 16) };
}
const mask = (v: string) => (v.length <= 10 ? "•".repeat(v.length) : `${v.slice(0, 4)}${"•".repeat(8)}${v.slice(-4)}`);

export interface AppOptions { db?: Db; logger?: boolean }

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance & { db: Db; engine: Engine }> {
  const db = opts.db ?? (await createDb());
  await seed(db);
  const engine = createEngine(db);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 30 * 1024 * 1024 });
  const artifacts = createArtifactStore();
  const TMP_UPLOADS = join(artifacts.root, "tmp");
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.decorate("db", db);
  app.decorate("engine", engine);

  app.addHook("onClose", async () => { if (!opts.db) await db.close(); });

  // ── auth (dev): Bearer dev_<tenant> або x-tenant-id ──
  app.decorateRequest("tenantId", DEFAULT_TENANT);
  app.addHook("preHandler", async (req: any, reply) => {
    if (req.url.startsWith("/healthz") || req.url.startsWith("/readyz") || req.url === "/v1/meta") return;
    const auth = String(req.headers.authorization ?? "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const tenant = bearer.startsWith("dev_") ? bearer.slice(4) : String(req.headers["x-tenant-id"] ?? DEFAULT_TENANT);
    if (!/^tnt_[a-z0-9]{8,}$/.test(tenant)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "invalid tenant token" } });
    }
    req.tenantId = tenant;
  });

  const runView = (r: any): RunView => ({
    id: r.id, status: r.status, prompt: r.prompt, goalSpec: r.goal_spec ?? null, plan: r.plan ?? null,
    budget: r.budget, spentUsd: Number(r.spent_usd ?? 0),
    progress: { tasksTotal: (r.plan?.nodes?.length ?? 0), tasksDone: 0, currentTaskId: null },
    result: r.result ?? null, error: r.error ?? null,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  });

  app.get("/healthz", async () => ({ ok: true, driver: db.driver }));
  app.get("/readyz", async (_q, reply) => {
    try { await db.query("SELECT 1"); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  app.get("/v1/meta", async () => MetaResponse.parse({
    api_version: API_VERSION, server_time: new Date().toISOString(),
    min_app_version: MIN_APP_VERSION, latest_app_version: MIN_APP_VERSION,
    features: { sse: true, polling: true, presigned_upload: true, delta_sync: true, push: false, dry_run: true, mobile_auth: false },
    limits: { maxUploadMb: 25, maxPromptChars: 8000, maxRunsPerTenantConcurrent: 3 },
  }));

  // ── runs ──
  app.post("/v1/runs", async (req: any, reply) => {
    const parsed = CreateRunRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body", details: parsed.error.flatten() } });
    const body = parsed.data;
    const idem = String(req.headers[IDEMPOTENCY_HEADER] ?? "");

    if (idem) {
      const { rows } = await db.query<any>("SELECT response, status_code FROM idempotency_keys WHERE key=$1 AND tenant_id=$2 AND endpoint=$3", [idem, req.tenantId, "POST /v1/runs"]);
      if (rows[0]) return reply.code(rows[0].status_code).send({ ...rows[0].response, replayed: true });
    }

    const budget = { maxUsd: 0.5, maxDurationSeconds: 900, maxSteps: 40, ...(body.budget ?? {}) };
    const run = await db.tx(req.tenantId, async (q: QueryFn) => {
      const r = await insertRun(q, { tenantId: req.tenantId, userId: DEFAULT_USER, prompt: body.prompt, budget, dryRun: body.dryRun });
      await appendEvent(q, r.id, "run.created", { prompt: body.prompt, budget });
      return r;
    });
    engine.enqueue(run.id, req.tenantId);

    const payload = { run: runView({ ...run, budget }), replayed: false };
    if (idem) await db.query("INSERT INTO idempotency_keys (key, tenant_id, endpoint, response, status_code) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING",
      [idem, req.tenantId, "POST /v1/runs", JSON.stringify(payload), 201]).catch(() => {});
    return reply.code(201).send(payload);
  });

  app.get("/v1/runs", async (req: any, reply) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(100).default(20), cursor: z.string().optional(), updated_since: z.string().optional() }).parse(req.query ?? {});
    return db.tx(req.tenantId, async (tx) => {
      const { items, hasMore, next } = await listRuns(tx, { limit: q.limit, updatedSince: q.updated_since, cursor: q.cursor });
      return { items: items.map((r) => ({ id: r.id, status: r.status, prompt: r.prompt, spentUsd: Number(r.spent_usd), createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null })) as RunListItem[], next_cursor: next, has_more: hasMore, server_time: new Date().toISOString() };
    });
  });

  app.get("/v1/runs/:id", async (req: any, reply) => {
    return db.tx(req.tenantId, async (tx) => {
      const run = await getRun(tx, req.params.id);
      if (!run) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "run not found" } });
      const { rows: tasks } = await tx<any>("SELECT id, status, agent, goal, est_cost_usd, started_at, finished_at FROM tasks WHERE run_id=$1 ORDER BY id", [run.id]);
      return { run: runView(run), tasks: tasks.map((t) => ({ id: t.id, status: t.status, agent: t.agent, goal: t.goal, estCostUsd: Number(t.est_cost_usd), startedAt: t.started_at, finishedAt: t.finished_at })) };
    });
  });

  app.get("/v1/runs/:id/events", async (req: any) => {
    const since = Number((req.query as any)?.since ?? 0);
    return db.tx(req.tenantId, async (tx) => {
      const events = await getEvents(tx, req.params.id, since);
      const last = events.at(-1) as any;
      return { events: events.map((e: any) => ({ seq: e.seq, runId: req.params.id, type: e.type, payload: e.payload, createdAt: new Date(e.created_at).toISOString() })), last_seq: last?.seq ?? since, server_time: new Date().toISOString() };
    });
  });

  app.get("/v1/runs/:id/stream", async (req: any, reply) => {
    const runId = req.params.id;
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    let seq = Number((req.query as any)?.since ?? 0);
    let closed = false;
    req.raw.on("close", () => { closed = true; });
    const tick = async () => {
      if (closed) return;
      try {
        const events: any[] = await db.tx(req.tenantId, (tx) => getEvents(tx, runId, seq));
        for (const e of events) { seq = e.seq; reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, payload: e.payload })}\n\n`); }
        const run = await db.tx(req.tenantId, (tx) => getRun(tx, runId));
        if (run && ["done", "failed", "cancelled", "blocked"].includes(run.status)) { reply.raw.write("event: end\ndata: {}\n\n"); reply.raw.end(); return; }
      } catch { /* ignore */ }
      setTimeout(tick, 250);
    };
    tick();
    return reply;
  });

  app.post("/v1/runs/:id/cancel", async (req: any, reply) => {
    return db.tx(req.tenantId, async (tx) => {
      const run = await getRun(tx, req.params.id);
      if (!run) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "run not found" } });
      if (["done", "failed", "cancelled"].includes(run.status)) return { run: runView(run) };
      await setStatus(tx, run.id, "cancelled", { error: "cancelled by user" });
      await appendEvent(tx, run.id, "run.cancelled", { by: "user" });
      return { run: runView(await getRun(tx, run.id)) };
    });
  });

  // ── uploads (presigned, §34.4.3) ──
  app.post("/v1/uploads/presign", async (req: any, reply) => {
    const parsed = PresignRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    const uploadId = newId.up();
    const partSize = 5 * 1024 * 1024;
    const parts = Math.max(1, Math.ceil(parsed.data.sizeBytes / partSize));
    await db.query("INSERT INTO uploads (id, tenant_id, filename, mime, size_bytes) VALUES ($1,$2,$3,$4,$5)",
      [uploadId, req.tenantId, parsed.data.filename, parsed.data.mime, parsed.data.sizeBytes]);
    return reply.code(201).send({
      uploadId, partSizeBytes: partSize,
      parts: Array.from({ length: parts }, (_, i) => ({ partNumber: i + 1, url: `/v1/uploads/${uploadId}/parts/${i + 1}` })),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  });

  // Прийом байтів: локальний драйвер presigned-URL (у проді — S3/MinIO PUT)
  app.put("/v1/uploads/:id/parts/:n", async (req: any, reply) => {
    const { rows } = await db.query<any>("SELECT id FROM uploads WHERE id=$1 AND tenant_id=$2", [req.params.id, req.tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "upload not found" } });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "empty body" } });
    }
    await mkdir(TMP_UPLOADS, { recursive: true });
    await writeFile(join(TMP_UPLOADS, `${req.params.id}-${req.params.n}`), body);
    return { partNumber: Number(req.params.n), bytes: body.length, etag: String(body.length) };
  });

  app.post("/v1/uploads/:id/complete", async (req: any, reply) => {
    const { rows } = await db.query<any>("SELECT * FROM uploads WHERE id=$1 AND tenant_id=$2", [req.params.id, req.tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "upload not found" } });
    const upload = rows[0];
    let bytes: Buffer;
    try { bytes = await readFile(join(TMP_UPLOADS, `${upload.id}-1`)); }
    catch { return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "no parts uploaded" } }); }

    const stored = await artifacts.put({ bytes, mime: upload.mime, name: upload.filename });
    await db.query("INSERT INTO artifacts (key, tenant_id, mime, bytes, sha256, name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING",
      [stored.key, req.tenantId, stored.mime, stored.bytes, stored.sha256, stored.name ?? null]);
    const fileId = newId.file();
    await db.query("UPDATE uploads SET status='complete', file_id=$2 WHERE id=$1", [upload.id, fileId]);
    await rm(join(TMP_UPLOADS, `${upload.id}-1`), { force: true });

    const { exp, sig } = artifacts.sign(stored.key, 900);
    return {
      fileId,
      artifact: { key: stored.key, kind: "file", bytes: stored.bytes, mime: stored.mime, sha256: stored.sha256 },
      url: `/v1/artifacts/${stored.key}?exp=${exp}&sig=${sig}`,
      expiresIn: 900,
    };
  });

  app.get("/v1/artifacts/:key", async (req: any, reply) => {
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    const key = String(req.params.key);
    if (!exp || !sig) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "signature required" } });
    const check = artifacts.verify(key, Number(exp), String(sig));
    if (!check.ok) return reply.code(check.reason === "expired" ? 410 : 403).send({ error: { code: "FORBIDDEN", message: check.reason } });
    const { rows } = await db.query<any>("SELECT mime FROM artifacts WHERE key=$1 AND tenant_id=$2", [key, req.tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "artifact not found" } });
    const bytes = await artifacts.get(key);
    return reply.header("content-type", rows[0].mime).header("content-length", bytes.length).send(bytes);
  });

  // ── devices ──
  app.post("/v1/devices", async (req: any, reply) => {
    const parsed = RegisterDeviceRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    const d = parsed.data;
    const deviceId = newId.dev();
    await db.tx(req.tenantId, (tx) => tx(`INSERT INTO devices (id, tenant_id, user_id, platform, apns_token, app_version, locale, timezone)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, apns_token) DO UPDATE SET app_version=$6 RETURNING id`,
      [deviceId, req.tenantId, DEFAULT_USER, d.platform, d.apnsToken, d.appVersion, d.locale, d.timezone]));
    return reply.code(201).send({ deviceId });
  });

  // ── secrets (write-only, §17.15) ──
  app.post("/v1/secrets", async (req: any, reply) => {
    const body = z.object({ kind: z.enum(["api_key", "password", "oauth_token", "totp"]), label: z.string().min(1), value: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    const enc = encryptSecret(body.data.value);
    const secretRef = newId.sec();
    await db.tx(req.tenantId, (tx) => tx("INSERT INTO secrets (id, tenant_id, kind, label, ciphertext, iv, tag, fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [secretRef, req.tenantId, body.data.kind, body.data.label, enc.ciphertext, enc.iv, enc.tag, enc.fingerprint]));
    return reply.code(201).send({ secretRef, masked: mask(body.data.value), fingerprint: enc.fingerprint, createdAt: new Date().toISOString() });
  });

  return Object.assign(app, { db, engine }) as any;
}
