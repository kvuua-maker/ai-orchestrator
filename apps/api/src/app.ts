import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import crypto from "node:crypto";
import { z } from "zod";
import {
  CreateRunRequest, IDEMPOTENCY_HEADER, MetaResponse, PresignRequest, RegisterDeviceRequest,
  API_VERSION, MIN_APP_VERSION, type RunView, type RunListItem,
} from "@aio/shared";
import { createDb, seed, type Db, type QueryFn } from "./db/index.js";
import { createEngine, type Engine } from "./engine/executor.js";
import { createLlm } from "./engine/llm.js";
import { bus } from "./conversation/bus.js";
import { createRegistry } from "./tools/index.js";
import { createEmbedder } from "./memory/embedder.js";
import { getPendingHandoff, listHandoffs, resolveHandoff, reopenTask } from "./engine/handoff.js";
import { reconcileStalledRuns } from "./engine/recovery.js";
import { metrics } from "./observability/metrics.js";
import { writeAudit, listAudit } from "./observability/audit.js";
import { TRACE_HEADER, isValidTraceId, newTraceId, logLine } from "./observability/trace.js";
import { createServiceDb } from "./db/index.js";
import { runTurn } from "./conversation/turn.js";
import { buildSuggestions } from "./conversation/proactive.js";
import { preloadWhisper, transcribe } from "./voice/whisper.js";
import { ensureLiveBrowser, liveStatus, vncInfo } from "./live/session.js";
import { createConversation, listConversations, getConversation, getHistory } from "./conversation/store.js";
import { getQuota, getUsage, listPlans, setPlan, recordUsage, createInvoice, listInvoices } from "./billing/index.js";
import { ingestText, searchMemory, memoryStats } from "./memory/store.js";
import { cacheGet, cacheSet, cacheKey, cacheStats, cachePurgeExpired } from "./memory/cache.js";
import { appendEvent, getEvents, getRun, insertRun, listRuns, setStatus } from "./repo/runs.js";
import { newId } from "./ids.js";
import { createArtifactStore } from "./artifacts/store.js";
import { processDocument, exportFile, planFolders } from "@aio/documents";
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

export interface AppOptions { db?: Db; logger?: boolean; engineDeps?: Partial<import("./engine/executor.js").EngineDeps> }

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance & { db: Db; engine: Engine }> {
  const db = opts.db ?? (await createDb());
  const artifacts = createArtifactStore();
  await seed(db);
  const embedder = createEmbedder();
  const llm = createLlm();
  const registry = createRegistry({ db, embedder });
  const engine = createEngine(db, { artifacts, registry, ...(opts.engineDeps ?? {}) });
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 30 * 1024 * 1024 });
  const TMP_UPLOADS = join(artifacts.root, "tmp");
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/m4a"],
    { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.decorateRequest("traceId", "");
  app.addHook("onRequest", async (req: any) => {
    const incoming = req.headers[TRACE_HEADER];
    req.traceId = isValidTraceId(incoming) ? incoming : newTraceId();
    req.startTime = Date.now();
    req.log.info(logLine("info", "request.start", {
      traceId: req.traceId, method: req.method, url: req.url.split("?")[0],
    }));
  });
  app.addHook("onResponse", async (req: any, reply) => {
    const ms = Date.now() - (req.startTime ?? Date.now());
    const route = req.routeOptions?.url ?? req.url.split("?")[0];
    metrics.inc("aio_http_requests_total", { method: req.method, route, status: reply.statusCode });
    metrics.observe("aio_http_duration_ms", ms, { route });
    req.log.info(logLine(reply.statusCode >= 500 ? "error" : "info", "request.end", {
      traceId: req.traceId, method: req.method, route, status: reply.statusCode, ms,
    }));
  });

  // Браузер з іншого origin: без цього UI з :3000 не міг звертатись до :4000 взагалі
  const allowedOrigins = (process.env.WEB_ORIGIN ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",").map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      // Відмова без CORS-заголовків: браузер заблокує запит, а сервер не віддасть 500
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      metrics.inc("aio_cors_denied_total", { origin: origin.slice(0, 60) });
      cb(null, false);
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-tenant-id", "idempotency-key", "x-trace-id"],
    exposedHeaders: ["x-trace-id", "x-cache"],
    maxAge: 600,
  });

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

  app.addHook("onSend", async (req: any, reply, payload) => {
    reply.header(TRACE_HEADER, req.traceId ?? "");
    return payload;
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

    const quota = await db.tx(req.tenantId, (q) => getQuota(q, req.tenantId));
    if (!quota.allowed) {
      metrics.inc("aio_quota_denied_total", { reason: quota.reason ?? "unknown" });
      return reply.code(402).send({ error: {
        code: "QUOTA_EXCEEDED", message: `квоту вичерпано: ${quota.reason}`,
        details: { plan: quota.plan.id, runsRemaining: quota.runsRemaining, tokensRemaining: quota.tokensRemaining,
                   periodEnd: quota.usage.periodEnd },
      } });
    }

    const budget = { maxUsd: 0.5, maxDurationSeconds: 900, maxSteps: 40, ...(body.budget ?? {}) };
    const run = await db.tx(req.tenantId, async (q: QueryFn) => {
      const r = await insertRun(q, { tenantId: req.tenantId, userId: DEFAULT_USER, prompt: body.prompt, budget, dryRun: body.dryRun });
      await appendEvent(q, r.id, "run.created", { prompt: body.prompt, budget, traceId: req.traceId });
      await writeAudit(q, { tenantId: req.tenantId, actorType: "user", actorId: DEFAULT_USER,
        action: "run.created", resource: "run", resourceId: r.id, traceId: req.traceId, ip: req.ip,
        meta: { promptChars: body.prompt.length, dryRun: body.dryRun } });
      return r;
    });
    await db.tx(req.tenantId, (q) => recordUsage(q, { tenantId: req.tenantId, runId: run.id, kind: "run", quantity: 1 }));
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
      const pending = await getPendingHandoff(tx, run.id);
      return { run: runView(run), handoff: pending, tasks: tasks.map((t) => ({ id: t.id, status: t.status, agent: t.agent, goal: t.goal, estCostUsd: Number(t.est_cost_usd), startedAt: t.started_at, finishedAt: t.finished_at })) };
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
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "content-encoding": "identity",
      connection: "keep-alive",
    });
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
      await writeAudit(tx, { tenantId: req.tenantId, actorType: "user", actorId: DEFAULT_USER,
        action: "run.cancelled", resource: "run", resourceId: run.id, traceId: req.traceId, ip: req.ip });
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
    const fileId = newId.file();
    await db.tx(req.tenantId, async (q) => {
      await q("INSERT INTO artifacts (key, tenant_id, mime, bytes, sha256, name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING",
        [stored.key, req.tenantId, stored.mime, stored.bytes, stored.sha256, stored.name ?? null]);
      await q("UPDATE uploads SET status='complete', file_id=$2 WHERE id=$1", [upload.id, fileId]);
    });
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
    const rows: any[] = await db.tx(req.tenantId, async (q) => {
      const r = await q<any>("SELECT mime FROM artifacts WHERE key=$1 AND tenant_id=$2", [key, req.tenantId]);
      return r.rows;
    });
    if (!rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "artifact not found" } });
    const bytes = await artifacts.get(key);
    return reply.header("content-type", rows[0].mime).header("content-length", bytes.length).send(bytes);
  });

  // ── tool catalog (§3.2.2) ──
  app.get("/v1/tools", async (req: any) => {
    const q = z.object({ q: z.string().optional(), agent: z.string().optional(), risk: z.string().optional() }).parse(req.query ?? {});
    const items = registry.catalog(q);
    return { items, total: items.length, server_time: new Date().toISOString() };
  });

  app.get("/v1/tools/:name", async (req: any, reply) => {
    const versions = registry.versions(req.params.name);
    if (!versions.length) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "tool not found" } });
    const tool = registry.resolve(req.params.name, (req.query as any)?.version ?? "*");
    return {
      name: tool.definition.name,
      latest: versions.at(-1),
      versions,
      definition: tool.definition,
      deprecated: tool.deprecated ?? null,
    };
  });

  app.post("/v1/tools/:name/simulate", async (req: any, reply) => {
    const body = z.object({ args: z.record(z.any()).default({}), version: z.string().optional(), agent: z.string().default("synthesizer") }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    const tool = registry.has(req.params.name) ? registry.resolve(req.params.name, body.data.version ?? "*") : null;
    if (!tool) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "tool not found" } });
    const ctx = { tenantId: req.tenantId, runId: "sim", taskId: "sim", dryRun: true, budgetUsd: 1, artifacts };
    const policy = registry.checkPolicy(tool, ctx, body.data.agent);
    if (!policy.ok) return reply.code(403).send({ error: { code: "POLICY_DENIED", message: policy.reason } });
    if (tool.simulate) return tool.simulate(body.data.args, ctx);

    // Немає simulate(): все одно валідуємо вхід, щоб dry-run не брехав
    const parsed = tool.inputZod.safeParse(body.data.args);
    if (!parsed.success) {
      return { ok: false, error: { code: "VALIDATION", retryable: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
    }
    return { ok: true, data: { simulated: true, reason: "no simulate(); input is valid, pure tool would run as-is" }, costMicros: 0, cached: false, dryRun: true, evidence: [], artifacts: [] };
  });

  // ── білінг і квоти (§19) ──
  app.get("/v1/billing/plan", async (req: any) =>
    db.tx(req.tenantId, async (q) => ({ quota: await getQuota(q, req.tenantId), plans: await listPlans(q) })));

  app.get("/v1/billing/usage", async (req: any) =>
    db.tx(req.tenantId, async (q) => ({ usage: await getUsage(q, req.tenantId), quota: await getQuota(q, req.tenantId) })));

  app.post("/v1/billing/plan", async (req: any, reply) => {
    const body = z.object({ planId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "planId required" } });
    const sub = await db.tx(req.tenantId, async (q) => {
      const plans = await listPlans(q);
      if (!plans.find((p) => p.id === body.data.planId)) return null;
      return setPlan(q, req.tenantId, body.data.planId);
    });
    if (!sub) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "plan not found" } });
    return { subscription: sub };
  });

  app.post("/v1/billing/invoices", async (req: any, reply) => {
    const inv = await db.tx(req.tenantId, async (q) => {
      await createInvoice(q, req.tenantId);
      return (await listInvoices(q, req.tenantId, 1))[0];
    }).catch(() => null);
    if (!inv) return reply.code(409).send({ error: { code: "CONFLICT", message: "no subscription" } });
    await db.tx(req.tenantId, (q) => writeAudit(q, { tenantId: req.tenantId, actorType: "user", actorId: DEFAULT_USER,
      action: "invoice.created", resource: "invoice", resourceId: inv.id, traceId: req.traceId, meta: { amount: inv.amount_usd } }));
    return reply.code(201).send({ invoice: inv });
  });

  app.get("/v1/billing/invoices", async (req: any) =>
    db.tx(req.tenantId, async (q) => ({ items: await listInvoices(q, req.tenantId), server_time: new Date().toISOString() })));

  // ── спостережуваність (§22) ──
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return metrics.prometheus();
  });

  app.get("/v1/observability/summary", async (req: any) => {
    const window = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).parse(req.query ?? {});
    const since = `now() - interval '${window.hours} hours'`;
    const out = await db.tx(req.tenantId, async (q) => {
      const byStatus = await q<any>(`SELECT status, count(*)::int AS n FROM runs WHERE created_at > ${since} GROUP BY status`);
      const totals = await q<any>(`SELECT count(*)::int AS runs, coalesce(sum(spent_usd),0)::float8 AS cost,
        count(*) FILTER (WHERE status='done')::int AS done,
        count(*) FILTER (WHERE status IN ('failed','stalled'))::int AS failed
        FROM runs WHERE created_at > ${since}`);
      const duration = await q<any>(`SELECT
        coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - created_at)) * 1000), 0)::int AS p50_ms,
        coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - created_at)) * 1000), 0)::int AS p95_ms
        FROM runs WHERE finished_at IS NOT NULL AND created_at > ${since}`);
      const handoffs = await q<any>(`SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
        count(*) FILTER (WHERE status='resolved')::int AS resolved FROM handoffs WHERE created_at > ${since}`);
      const tools = await q<any>(`SELECT payload->>'tool' AS tool, count(*)::int AS calls
        FROM run_events WHERE type='tool.result' AND created_at > ${since}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
      const failing = await q<any>(`SELECT payload->>'tool' AS tool, count(*)::int AS failures
        FROM run_events WHERE type='tool.result' AND payload->>'ok' = 'false' AND created_at > ${since}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
      return { byStatus: byStatus.rows, totals: totals.rows[0], duration: duration.rows[0], handoffs: handoffs.rows[0], tools: tools.rows, failing: failing.rows };
    });

    const t = out.totals ?? { runs: 0, cost: 0, done: 0, failed: 0 };
    return {
      window_hours: window.hours,
      runs: { total: t.runs, done: t.done, failed: t.failed, by_status: Object.fromEntries(out.byStatus.map((r: any) => [r.status, r.n])) },
      success_rate: t.runs ? Math.round((t.done / t.runs) * 1000) / 10 : 0,
      duration_ms: { p50: out.duration?.p50_ms ?? 0, p95: out.duration?.p95_ms ?? 0 },
      cost_usd: Math.round(Number(t.cost) * 10000) / 10000,
      handoffs: out.handoffs ?? { pending: 0, resolved: 0 },
      top_tools: out.tools,
      failing_tools: out.failing,
      process: metrics.snapshot(),
      server_time: new Date().toISOString(),
    };
  });

  app.get("/v1/audit", async (req: any) => {
    const q = z.object({ action: z.string().optional(), resourceId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query ?? {});
    const items = await db.tx(req.tenantId, (tx) => listAudit(tx, q));
    return { items, total: items.length, server_time: new Date().toISOString() };
  });

  // ── Діалог (§10.8) ──
  app.post("/v1/conversations", async (req: any, reply) => {
    const body = z.object({ title: z.string().max(80).optional() }).safeParse(req.body ?? {});
    const conv = await db.tx(req.tenantId, (q) => createConversation(q, req.tenantId, DEFAULT_USER, body.success ? body.data.title : undefined));
    return reply.code(201).send({ conversation: conv });
  });

  // ── голос: серверний Whisper (§13.11) ──
  app.post("/v1/voice/transcribe", async (req: any, reply) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 2000) {
      return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "audio required" } });
    }
    try {
      const lang = String((req.query as any)?.lang ?? "ukrainian");
      const out = await transcribe(body, String(req.headers["content-type"] ?? "audio/webm"), lang);
      metrics.inc("aio_stt_requests_total", { ok: "true" });
      metrics.observe("aio_stt_duration_ms", out.ms);
      return out;
    } catch (e: any) {
      metrics.inc("aio_stt_requests_total", { ok: "false" });
      return reply.code(500).send({ error: { code: "STT_FAILED", message: String(e.message).slice(0, 200) } });
    }
  });

  // ── живий браузер (людина проходить перевірку сама) ──
  app.get("/v1/live", async () => ({ ...(await liveStatus()), ...vncInfo() }));

  app.post("/v1/live/start", async (req: any) => {
    const url = String((req.body as any)?.url ?? "").trim();
    const r = await ensureLiveBrowser(url || undefined);
    return { ...r, ...(await liveStatus()), ...vncInfo() };
  });

  app.get("/v1/proactive", async (req: any) => {
    const out = await db.tx(req.tenantId, (q) => buildSuggestions(q, llm, embedder, req.tenantId));
    return { ...out, server_time: new Date().toISOString() };
  });

  app.get("/v1/conversations", async (req: any) => {
    const items = await db.tx(req.tenantId, (q) => listConversations(q));
    return { items, server_time: new Date().toISOString() };
  });

  app.get("/v1/conversations/:id", async (req: any, reply) => {
    const out = await db.tx(req.tenantId, async (q) => {
      const conv = await getConversation(q, req.params.id);
      if (!conv) return null;
      const messages = await getHistory(q, conv.id, 100);
      return { conversation: conv, messages };
    });
    if (!out) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "conversation not found" } });
    return out;
  });

  app.post("/v1/conversations/:id/messages", async (req: any, reply) => {
    const body = z.object({ text: z.string().min(1).max(8000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "text required" } });

    const quota = await db.tx(req.tenantId, (q) => getQuota(q, req.tenantId));
    if (!quota.allowed) return reply.code(402).send({ error: { code: "QUOTA_EXCEEDED", message: `квоту вичерпано: ${quota.reason}` } });

    const conv = await db.tx(req.tenantId, (q) => getConversation(q, req.params.id));
    if (!conv) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "conversation not found" } });

    const result = await runTurn(db, llm, embedder, engine, {
      tenantId: req.tenantId, userId: DEFAULT_USER, conversationId: conv.id, text: body.data.text,
    });
    metrics.inc("aio_turns_total", { intent: result.intent });
    return { ...result, traceId: req.traceId };
  });

  app.post("/v1/conversations/:id/start", async (req: any, reply) => {
    const body = z.object({ text: z.string().min(3).max(2000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "text required" } });
    const quota = await db.tx(req.tenantId, (q) => getQuota(q, req.tenantId));
    if (!quota.allowed) return reply.code(402).send({ error: { code: "QUOTA_EXCEEDED", message: `квоту вичерпано: ${quota.reason}` } });

    const conv = await db.tx(req.tenantId, (q) => getConversation(q, req.params.id));
    if (!conv) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "conversation not found" } });

    const run = await db.tx(req.tenantId, async (q) => {
      const r = await insertRun(q, { tenantId: req.tenantId, userId: DEFAULT_USER, prompt: body.data.text,
        budget: { maxUsd: 0.5, maxDurationSeconds: 900, maxSteps: 40 }, dryRun: false });
      await q("UPDATE runs SET conversation_id=$2 WHERE id=$1", [r.id, conv.id]);
      await appendEvent(q, r.id, "run.created", { prompt: body.data.text, fromConfirm: true });
      await recordUsage(q, { tenantId: req.tenantId, runId: r.id, kind: "run", quantity: 1 });
      return r;
    });
    engine.enqueue(run.id, req.tenantId);
    return reply.code(202).send({ runId: run.id });
  });

  // SSE: нові повідомлення розмови + події активного запуску
  app.get("/v1/conversations/:id/stream", async (req: any, reply) => {
    const convId = req.params.id;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "content-encoding": "identity",
      connection: "keep-alive",
    });
    let closed = false;
    req.raw.on("close", () => { closed = true; });
    let lastMsgAt = new Date(0).toISOString();
    const send = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // потік токенів і кроків — через шину, без опитування БД
    const unsubscribe = bus.subscribe(convId, (e) => {
      if (closed) return;
      send(e.type, e);
      if (e.type === "message.done") lastMsgAt = new Date().toISOString();
    });
    req.raw.on("close", () => unsubscribe());

    const tick = async () => {
      if (closed) return;
      try {
        const { rows } = await db.tx(req.tenantId, (q) => q<any>(
          `SELECT id, role, content, run_id, meta, created_at FROM messages
           WHERE conversation_id=$1 AND created_at > $2 ORDER BY created_at ASC LIMIT 20`, [convId, lastMsgAt]));
        for (const m of rows) {
          lastMsgAt = new Date(m.created_at).toISOString();
          send("message.created", m);
        }
      } catch { /* ignore */ }
      setTimeout(tick, 700);
    };
    tick();
    return reply;
  });

  // ── Handoff Protocol (§4.17) ──
  app.get("/v1/handoffs", async (req: any) => {
    const q = z.object({ status: z.enum(["pending", "resolved", "expired", "cancelled"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query ?? {});
    const items = await db.tx(req.tenantId, (tx) => listHandoffs(tx, q));
    return { items, total: items.length, server_time: new Date().toISOString() };
  });

  app.post("/v1/handoffs/:id/resolve", async (req: any, reply) => {
    const body = z.object({ answer: z.string().max(4000).optional(), option: z.string().max(64).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    if (!body.data.answer && !body.data.option) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "answer or option required" } });

    const outcome = await db.tx(req.tenantId, async (tx) => {
      const r = await resolveHandoff(tx, req.params.id, body.data);
      if (!r.ok) return r;
      const run = await getRun(tx, r.handoff.run_id);
      return { ...r, run };
    });
    if (!outcome.ok) {
      const code = outcome.reason === "not_found" ? 404 : 409;
      return reply.code(code).send({ error: { code: code === 404 ? "NOT_FOUND" : "CONFLICT", message: outcome.reason } });
    }
    const run = (outcome as any).run;
    if (run && run.status === "blocked") {
      await db.tx(req.tenantId, (tx) => appendEvent(tx, run.id, "handoff.resolved", {
        handoffId: outcome.handoff.id, option: body.data.option ?? null,
      }));
      await db.tx(req.tenantId, (tx) => writeAudit(tx, { tenantId: req.tenantId, actorType: "user", actorId: DEFAULT_USER,
        action: "handoff.resolved", resource: "handoff", resourceId: outcome.handoff.id, traceId: req.traceId, ip: req.ip,
        meta: { option: body.data.option ?? null } }));
      // крок, що зупинився, виконується повторно; відповідь людини стає фактом у run
      await db.tx(req.tenantId, async (tx) => {
        await reopenTask(tx, outcome.handoff);
        await tx(`UPDATE runs SET result = coalesce(result,'{}'::jsonb)
                  || jsonb_build_object('humanConfirmed', true)
                  || CASE WHEN $2::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('manualAnswer', $2::text) END
                  WHERE id=$1`, [run.id, body.data.answer ?? null]);
      });
      engine.resume(run.id, req.tenantId);
    }
    return { handoff: { id: outcome.handoff.id, status: outcome.handoff.status }, runId: run?.id ?? null, resumed: !!run };
  });

  app.post("/v1/runs/:id/resume", async (req: any, reply) => {
    const run = await db.tx(req.tenantId, (tx) => getRun(tx, req.params.id));
    if (!run) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "run not found" } });
    if (!["blocked", "stalled", "failed"].includes(run.status)) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: `cannot resume from ${run.status}` } });
    }
    await db.tx(req.tenantId, (tx) => writeAudit(tx, { tenantId: req.tenantId, actorType: "user", actorId: DEFAULT_USER,
      action: "run.resumed", resource: "run", resourceId: run.id, traceId: req.traceId, ip: req.ip,
      meta: { from: run.status } }));
    engine.resume(run.id, req.tenantId);
    return reply.code(202).send({ runId: run.id, resumed: true });
  });

  app.post("/v1/runs/reconcile", async (req: any, reply) => {
    const body = z.object({ staleAfterMs: z.number().int().min(1000).optional(), allTenants: z.boolean().optional() }).safeParse(req.body ?? {});
    const staleAfterMs = body.success ? body.data.staleAfterMs : undefined;
    if (body.success && body.data.allTenants) {
      // фоновий обхід усіх тенантів — окрема сервісна роль (§22.5)
      let svc;
      try { svc = await createServiceDb(); }
      catch (e) {
        return reply.code(503).send({ error: { code: "SERVICE_DB_UNAVAILABLE", message: "SERVICE_DATABASE_URL не налаштований" } });
      }
      try { return await reconcileStalledRuns(svc, { staleAfterMs }); } finally { await svc.close(); }
    }
    return reconcileStalledRuns(db, { staleAfterMs, tenantId: req.tenantId });
  });

  // ── memory & RAG (§10) ──
  app.post("/v1/memory/ingest", async (req: any, reply) => {
    const body = z.object({
      sourceType: z.enum(["document", "run", "note", "contact"]).default("note"),
      sourceId: z.string().min(1).max(200),
      text: z.string().min(1).max(200_000),
    }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    const r = await db.tx(req.tenantId, (q) => ingestText(q, { ...body.data, tenantId: req.tenantId, embedder }));
    return reply.code(201).send(r);
  });

  app.post("/v1/memory/search", async (req: any, reply) => {
    const body = z.object({
      query: z.string().min(1).max(2000),
      k: z.number().int().min(1).max(50).default(5),
      sourceType: z.enum(["document", "run", "note", "contact"]).optional(),
      threshold: z.number().min(0).max(1).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    const [qv] = await embedder.embed([body.data.query]);
    const hits = await db.tx(req.tenantId, (q) => searchMemory(q, { embedding: Array.from(qv!), ...body.data }));
    return { hits, embedder: embedder.name, server_time: new Date().toISOString() };
  });

  app.get("/v1/memory/stats", async (req: any) => db.tx(req.tenantId, (q) => memoryStats(q)));

  // ── response cache (§10.6) ──
  app.get("/v1/cache/stats", async (req: any) => db.tx(req.tenantId, (q) => cacheStats(q)));
  app.post("/v1/cache/purge", async (req: any) => ({ purged: await db.tx(req.tenantId, (q) => cachePurgeExpired(q)) }));

  // ── documents pipeline (§13) ──
  app.post("/v1/documents/process", async (req: any, reply) => {
    const body = z.object({ key: z.string().length(64) }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "key required" } });
    const rows: any[] = await db.tx(req.tenantId, async (q) => {
      const r = await q<any>("SELECT mime, name FROM artifacts WHERE key=$1 AND tenant_id=$2", [body.data.key, req.tenantId]);
      return r.rows;
    });
    if (!rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "artifact not found" } });

    let bytes: Buffer;
    try { bytes = await artifacts.get(body.data.key); } catch { return reply.code(404).send({ error: { code: "NOT_FOUND", message: "blob missing" } }); }

    const ck = cacheKey({ tenantId: req.tenantId, kind: "doc.process", payload: { key: body.data.key }, version: "v1" });
    const cached = await db.tx(req.tenantId, (q) => cacheGet<any>(q, ck));
    if (cached) return reply.header("x-cache", "hit").send(cached);

    const result = await processDocument({ name: rows[0].name ?? "file", bytes, mime: rows[0].mime });
    const payload = {
      status: result.status, mime: result.mime, pages: result.pages, engine: result.engine,
      sha256: result.sha256, reasons: result.reasons,
      parsed: result.parsed ? {
        total: result.parsed.total.value, date: result.parsed.date.value,
        edrpou: result.parsed.edrpou.value, vat: result.parsed.vat.value,
        items: result.parsed.items.length, quality: result.parsed.quality,
      } : null,
      validation: result.validation,
    };
    await db.tx(req.tenantId, (q) => cacheSet(q, { key: ck, tenantId: req.tenantId, kind: "doc.process", payload, ttlSeconds: 7 * 86400 })).catch(() => {});
    return reply.header("x-cache", "miss").send(payload);
  });

  app.post("/v1/documents/export", async (req: any, reply) => {
    const body = z.object({
      format: z.enum(["xlsx", "docx", "pdf"]),
      title: z.string().min(1).max(120),
      columns: z.array(z.string()).min(1).max(20),
      rows: z.array(z.record(z.any())).max(5000),
    }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });

    const file = await exportFile(body.data.format, {
      title: body.data.title, columns: body.data.columns, rows: body.data.rows as any,
      meta: { "Створено": new Date().toISOString().slice(0, 10), "Джерело": "AI Orchestrator" },
    });
    const stored = await artifacts.put({ bytes: file.bytes, mime: file.mime, name: file.name });
    await db.tx(req.tenantId, (q) => q(
      "INSERT INTO artifacts (key, tenant_id, mime, bytes, sha256, name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING",
      [stored.key, req.tenantId, stored.mime, stored.bytes, stored.sha256, file.name]));
    const { exp, sig } = artifacts.sign(stored.key, 900);
    return reply.code(201).send({
      key: stored.key, name: file.name, mime: file.mime, bytes: stored.bytes,
      url: `/v1/artifacts/${stored.key}?exp=${exp}&sig=${sig}`,
    });
  });

  app.post("/v1/documents/folders", async (req: any, reply) => {
    const body = z.object({
      docs: z.array(z.object({ key: z.string(), name: z.string(), date: z.string().nullable().optional(),
        merchant: z.string().nullable().optional(), total: z.number().nullable().optional(), sha256: z.string() })).max(2000),
      pattern: z.enum(["yyyy/mm/merchant", "yyyy/mm"]).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "invalid body" } });
    return planFolders(body.data.docs, { pattern: body.data.pattern });
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
    await db.tx(req.tenantId, (tx) => writeAudit(tx, { tenantId: req.tenantId, actorType: "user", actorId: DEFAULT_USER,
      action: "secret.created", resource: "secret", resourceId: secretRef, traceId: req.traceId, ip: req.ip,
      meta: { kind: body.data.kind, label: body.data.label } }));
    return reply.code(201).send({ secretRef, masked: mask(body.data.value), fingerprint: enc.fingerprint, createdAt: new Date().toISOString() });
  });

  return Object.assign(app, { db, engine }) as any;
}
