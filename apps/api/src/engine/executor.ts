import { interpretPhoneQuery, searchQuery } from "../conversation/products.js";
import type { GoalSpec, Plan, TaskNode, TaskResult } from "@aio/shared";
import type { Db, QueryFn } from "../db/index.js";
import { appendEvent, getRun, insertTasks, setStatus, updateTask } from "../repo/runs.js";
import { registry as defaultRegistry, type ToolRegistry } from "../tools/index.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { BudgetExceeded, BudgetGuard } from "./budget.js";
import { classifyFailure, LoopGuard, type DeadEndVerdict } from "./autonomy.js";
import { ArgsUnavailable, inferableTools, inferToolArgs } from "./tool-args.js";
import { createHandoff, getPendingHandoff } from "./handoff.js";
import { createLlm, type LlmClient } from "./llm.js";
import { createPlanner } from "./planner.js";
import { createRouter } from "./router.js";
import { runPlan } from "./scheduler.js";
import { streamFinale } from "../conversation/brain.js";
import { addMessage } from "../conversation/store.js";
import { bus } from "../conversation/bus.js";

export interface Engine {
  enqueue(runId: string, tenantId: string): void;
  resume(runId: string, tenantId: string): void;
  drain(): Promise<void>;
}

export interface EngineDeps {
  llm?: LlmClient;
  registry?: ToolRegistry;
  concurrency?: number;
  artifacts?: ArtifactStore;
  /** Для тестів: підміна роутера/планувальника. */
  router?: { name: string; route(prompt: string): Promise<{ goalSpec: GoalSpec; source: string }> };
  planner?: { name: string; plan(goal: GoalSpec, prompt: string): Promise<Plan> };
}

const URL_RE = /https?:\/\/[^\s)]+/;

/** Магазини й маркетплейси без JS не віддають контент — одразу відкриваємо браузером. */
const SHOP_HOSTS = /(rozetka|comfy|prom\.ua|epicentr|citrus|moyo|foxtrot|allo|telemart|ct\.ua|makeup|notino|ajax|iherb|amazon|ebay|aliexpress)/i;
const prefersBrowser = (url: string) => SHOP_HOSTS.test(url);

export function createEngine(db: Db, deps: EngineDeps = {}): Engine {
  const llm = deps.llm ?? createLlm();
  const tools = deps.registry ?? defaultRegistry;
  const router = deps.router ?? createRouter(llm);
  // планувальник бачить лише інструменти, чиї аргументи рушій може вивести
  const planner = deps.planner ?? createPlanner(llm, inferableTools(tools));
  const concurrency = deps.concurrency ?? 3;
  const artifacts = deps.artifacts;
  const pending: Promise<void>[] = [];

  async function execute(runId: string, tenantId: string, opts: { resume?: boolean } = {}) {
    const step = <T>(fn: (q: QueryFn) => Promise<T>) => db.tx(tenantId, fn);

    const run = await step((q) => getRun(q, runId));
    if (!run || run.status === "cancelled" || run.status === "done") return;

    const budgetCfg = (run.budget ?? {}) as { maxUsd?: number };
    const guard = new BudgetGuard(Number(budgetCfg.maxUsd ?? 0.5), (snap) => {
      void step((q) => appendEvent(q, runId, "budget.warning", { ...snap })).catch(() => {});
    });
    const loops = new LoopGuard(2);
    let paused: DeadEndVerdict | null = null;

    let plan: Plan;
    let skipDone: Set<string> | undefined;

    if (opts.resume && run.plan) {
      plan = run.plan as Plan;
      const { rows } = await step((q) => q<any>("SELECT id, status FROM tasks WHERE run_id=$1", [runId]));
      skipDone = new Set(rows.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.id));
      await step(async (q) => {
        await setStatus(q, runId, "running");
        await appendEvent(q, runId, "run.resumed", { skipped: skipDone!.size, total: plan.nodes.length });
      });
    } else {
      await step((q) => setStatus(q, runId, "planning"));
      const routed = await router.route(run.prompt);
      const goal: GoalSpec = routed.goalSpec;
      await step((q) => q("UPDATE runs SET goal_spec=$2::jsonb WHERE id=$1", [runId, JSON.stringify(goal)]));

      plan = await planner.plan(goal, run.prompt);
      await step(async (q) => {
        await q("UPDATE runs SET plan=$2::jsonb WHERE id=$1", [runId, JSON.stringify(plan)]);
        await insertTasks(q, runId, plan.nodes);
        await appendEvent(q, runId, "plan.created", {
          planId: plan.planId, nodes: plan.nodes.length,
          router: router.name, planner: planner.name,
          estimatedUsd: plan.estimatedTotalUsd, risk: goal.riskLevel,
        });
        await setStatus(q, runId, "running");
      });
    }

    const findings: string[] = [];
    const convId = (run as any).conversation_id as string | null;
    const publishStep = (label: string, status: "running" | "done" | "failed", icon?: string) => {
      if (convId) bus.publish(convId, { type: "step", runId, label, status, icon });
    };

    const schedule = await runPlan(plan, async (node: TaskNode): Promise<TaskResult> => {
      const t0 = Date.now();
      await step(async (q) => {
        await q("UPDATE runs SET last_heartbeat_at=now() WHERE id=$1", [runId]);
        await updateTask(q, node.id, "running");
        await appendEvent(q, runId, "task.started", { taskId: node.id, agent: node.agent, goal: node.goal });
      });
      publishStep(node.goal, "running", "⏳");

      const out: TaskResult = {
        status: "success", summary: node.goal, artifacts: [], evidence: [], blockers: [], nextHints: [],
        metrics: { steps: 0, tokens: 0, costUsd: 0, durationMs: 0 },
      };

      for (const rawTool of node.tools) {
        const url = node.goal.match(URL_RE)?.[0] ?? run.prompt.match(URL_RE)?.[0] ?? "";
        // магазин → браузер, навіть якщо план сказав http.fetch
        let toolName = rawTool === "http.fetch" && prefersBrowser(url) && tools.has("browser.open") ? "browser.open" : rawTool;
        // зворотне правило: браузер для звичайної сторінки — зайві 5–10 с
        if (toolName === "browser.open" && url && !prefersBrowser(url) && tools.has("http.fetch")) toolName = "http.fetch";
        if (toolName !== rawTool) publishStep(`Магазин — відкриваю справжнім браузером`, "running", "🌐");
        const loopKey = `${toolName}:${url}`;

        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = inferToolArgs(tools, toolName, node, run.prompt);
        } catch (e) {
          if (e instanceof ArgsUnavailable) {
            // Не викликаємо інструмент навмання: фіксуємо, чого не вистачає
            out.status = "failed";
            out.summary = `Аргументи недоступні: ${e.missing.join(", ")}`;
            out.blockers.push(e.message);
            break;
          }
          throw e;
        }
        if (loops.observe(loopKey)) {
          paused = { kind: "dead_end", reason: "loop_detected", message: `Повтор ${loopKey} — агент застряг` };
          out.status = "blocked";
          out.summary = "виявлено цикл";
          break;
        }

        await step((q) => appendEvent(q, runId, "tool.called", { taskId: node.id, tool: toolName, args: Object.keys(toolArgs) }));

        // «живий» індикатор: кожні 4 с показуємо, що робота триває
        const startedAt = Date.now();
        const beat = setInterval(() => {
          const sec = Math.round((Date.now() - startedAt) / 1000);
          publishStep(`${node.goal.slice(0, 60)} · ${sec} с`, "running", "⏳");
        }, 4000);

        let res = await tools.invoke(toolName, toolArgs, {
          tenantId, runId, taskId: node.id, dryRun: run.dry_run,
          budgetUsd: guard.snapshot().remainingUsd, artifacts,
        }, node.agent);

        // якщо швидкий HTTP дав порожньо — піднімаємо важку артилерію
        if (toolName === "http.fetch" && res.ok) {
          const body = String((res.data as any)?.text ?? "");
          if (body.replace(/\s/g, "").length < 300 && tools.has("browser.open")) {
            publishStep("Сторінка порожня без JS — відкриваю браузером", "running", "🌐");
            res = await tools.invoke("browser.open", toolArgs, {
              tenantId, runId, taskId: node.id, dryRun: run.dry_run,
              budgetUsd: guard.snapshot().remainingUsd, artifacts,
            }, node.agent);
            toolName = "browser.open";
          }
        }
        clearInterval(beat);

        if (res.ok) {
          await step((q) => appendEvent(q, runId, "tool.result", { taskId: node.id, tool: toolName, ok: true, summary: "ok" }));
          const d = res.data as any;
          // ціни — окремим рядком, інакше вони губляться в перших 400 символах сторінки
          if (Array.isArray(d?.prices) && d.prices.length) findings.push(`Знайдені ціни: ${d.prices.slice(0, 12).join(", ")}`);
          if (d?.title) findings.push(`Сторінка: ${d.title}`);
          if (d?.text) findings.push(String(d.text).slice(0, 1500));
          out.summary = `Отримано ${d?.bytes ?? 0} байт (HTTP ${d?.status ?? "?"})`;
          publishStep(d?.bytes ? `Прочитав ${d.bytes} байт (HTTP ${d.status})` : node.goal, "done", "✓");
        } else {
          await step((q) => appendEvent(q, runId, "tool.result", {
            taskId: node.id, tool: toolName, ok: false, summary: res.error.code }));

          // Реєстр уже виконав свої ретраї → для класифікатора спроби вичерпані
          const verdict = classifyFailure({
            tool: toolName, error: res.error, attempts: 2, maxAttempts: 2, goalText: run.prompt,
          });
          out.status = "blocked";
          out.summary = `Зупинка: ${verdict.reason}`;
          publishStep(`Не вдалося: ${verdict.reason}`, "failed", "✕");
          out.blockers.push(verdict.message);

          // ── Живий браузер: людина сама проходить перевірку, агент потім працює в тій самій сесії ──
          if (/antibot|blocked|captcha/i.test(verdict.reason ?? "")) {
            try {
              const { ensureLiveBrowser, vncInfo } = await import("../live/session.js");
              await ensureLiveBrowser(url || undefined);
              const v = vncInfo();
              if (v.url) {
                verdict.question = `Сайт показує перевірку безпеки. Відкрийте живий браузер: ${v.url}/vnc.html?autoconnect=1&resize=scale `
                  + `(пароль VNC: ${v.password}). Пройдіть перевірку там — потім натисніть «Продовжити», і я працюватиму в цій самій сесії з вашими cookies.`;
                publishStep("Відкрив живий браузер для вас", "done", "🖥");
                // зупиняємось і чекаємо людину: жодних «альтернатив» замість її сайту
                out.status = "blocked";
                out.summary = "handoff: живий браузер";
                out.blockers.push(verdict.question);
                paused = verdict;
                const h = await step((q) => createHandoff(q, { tenantId, runId, taskId: node.id, verdict }));
                await step((q) => appendEvent(q, runId, "handoff.requested", {
                  handoffId: h.id, reason: verdict.reason, kind: verdict.kind,
                  question: h.question, options: h.options, live: true,
                }));
                break;
              }
            } catch { /* живий браузер недоступний — лишаємо звичайний handoff */ }
          }
          // ── запасний варіант: ціни з маркетплейсів (якщо живий браузер недоступний) ──
          // Smart Fallback: блокування прямого сайту → сам шукаю ціни на маркетплейсах
          if (/antibot|blocked/i.test(verdict.reason ?? "") && tools.has("market.prices")) {
            // запит має бути назвою товару, а не текстом задачі
            const q = searchQuery(run.prompt) || searchQuery(node.goal) || run.prompt.slice(0, 60);
            publishStep("Сайт блокує — шукаю ціни на маркетплейсах", "running", "🔎");
            const fb = await tools.invoke("market.prices", { query: q }, {
              tenantId, runId, taskId: node.id, dryRun: run.dry_run,
              budgetUsd: guard.snapshot().remainingUsd, artifacts,
            }, "browser");
            await step((qq) => appendEvent(qq, runId, "tool.called", { taskId: node.id, tool: "market.prices", args: ["query"], fallback: true }));
            let fbFinal = fb;
            // якщо нічого — пробуємо коротший запит (лише модель)
            if (fb.ok && !(fb.data as any)?.items?.length) {
              const short = q.split(/\s+/).slice(0, 3).join(" ");
              if (short && short !== q) fbFinal = await tools.invoke("market.prices", { query: short }, {
                tenantId, runId, taskId: node.id, dryRun: run.dry_run,
                budgetUsd: guard.snapshot().remainingUsd, artifacts,
              }, "browser");
            }
            if (fbFinal.ok) {
              const d2 = fbFinal.data as any;
              if (d2?.items?.length) findings.push(`Ціни (${d2.summary}): ` + d2.items.slice(0, 8).map((i: any) => `${i.price} грн — ${i.title.slice(0, 50)} (${i.source})`).join("; "));
              publishStep(`Знайшов ${d2?.items?.length ?? 0} пропозицій в обхід блоку`, "done", "✓");
              out.status = "success";
              out.summary = d2?.summary ?? "знайдено ціни";
              break;
            }
          }
          const humanAlready = Boolean((run.result as any)?.humanConfirmed);
          if (verdict.kind === "needs_human" && humanAlready) {
            // людина вже підтвердила — не питаємо вдруге, крок пропускаємо честно
            publishStep("Людина підтвердила, але сайт усе ще блокує — пропускаю крок", "done", "↷");
            out.status = "success";
            out.summary = "крок пропущено після підтвердження людини";
            break;
          }
          if (verdict.kind === "needs_human" || verdict.kind === "hard_limit") {
            paused = verdict;
            const handoff = await step((q) => createHandoff(q, { tenantId, runId, taskId: node.id, verdict }));
            await step((q) => appendEvent(q, runId, "handoff.requested", {
              handoffId: handoff.id, reason: verdict.reason, kind: verdict.kind,
              question: handoff.question, options: handoff.options, alternative: verdict.alternative,
            }));
          } else {
            paused = verdict;
          }
          break;
        }
      }

      try { guard.charge(node.estCostUsd); }
      catch (e) {
        if (e instanceof BudgetExceeded) {
          out.status = "blocked"; out.summary = "бюджет вичерпано"; out.blockers.push(e.message);
          paused = { kind: "dead_end", reason: "budget_exhausted", message: e.message };
        } else throw e;
      }

      out.metrics = { steps: 1, tokens: 0, costUsd: node.estCostUsd, durationMs: Date.now() - t0 };
      if (out.status === "success") publishStep(node.goal, "done", "✓");
      await step(async (q) => {
        await updateTask(q, node.id, out.status === "success" ? "done" : out.status === "failed" ? "failed" : "skipped");
        await appendEvent(q, runId, "task.finished", { taskId: node.id, status: out.status, ms: out.metrics.durationMs });
      });
      return out;
    }, {
      concurrency, skipDone,
      shouldStop: () => paused !== null,
      onSkip: async (node, reason) => {
        await step(async (q) => {
          await updateTask(q, node.id, "skipped");
          await appendEvent(q, runId, "task.skipped", { taskId: node.id, reason });
        });
      },
    });

    const snap = guard.snapshot();
    const handoff = await step((q) => getPendingHandoff(q, runId));
    // paused змінюється в колбеку runNode — TS не бачить цього, тому явний тип
    const pauseVerdict = paused as DeadEndVerdict | null;

    if (handoff || (pauseVerdict && pauseVerdict.kind !== "dead_end")) {
      const verdict = pauseVerdict ?? { kind: "needs_human" as const, reason: "awaiting_human", message: "очікує рішення" };
      await step(async (q) => {
        await q("UPDATE runs SET spent_usd=$2 WHERE id=$1", [runId, snap.spentUsd]);
        await appendEvent(q, runId, "run.blocked", { reason: verdict.reason, handoffId: handoff?.id ?? null });
        await setStatus(q, runId, "blocked", { result: {
          status: "blocked", summary: `Зупинено: ${verdict.reason}`,
          data: { handoffId: handoff?.id, kind: verdict.kind }, artifacts: [], evidence: [],
          blockers: [verdict.message], nextHints: ["resolve handoff and resume"],
          metrics: { steps: plan.nodes.length, tokens: 0, costUsd: snap.spentUsd, durationMs: 0 },
        } as TaskResult });
      });
      return;
    }

    if (pauseVerdict) {
      const v = pauseVerdict;
      await step(async (q) => {
        await q("UPDATE runs SET spent_usd=$2 WHERE id=$1", [runId, snap.spentUsd]);
        await appendEvent(q, runId, "run.failed", { reason: v.reason, message: v.message });
        await setStatus(q, runId, "failed", { error: `${v.reason}: ${v.message}` });
      });
      return;
    }

    const anyFailed = schedule.failed.length > 0;
    const status = anyFailed && schedule.completed.length === 0 ? "failed" : "done";
    const result: TaskResult = {
      status: anyFailed ? "partial" : "success",
      summary: anyFailed
        ? `Виконано ${schedule.completed.length}/${plan.nodes.length}, провалено ${schedule.failed.length}.`
        : `Готово: ${plan.nodes.length} кроків, $${snap.spentUsd.toFixed(4)}.`,
      data: { findings: findings.slice(0, 3), plan: plan.planId },
      artifacts: [], evidence: [], blockers: [], nextHints: [],
      metrics: { steps: plan.nodes.length, tokens: 0, costUsd: snap.spentUsd, durationMs: 0 },
    };

    await step(async (q) => {
      await q("UPDATE runs SET spent_usd=$2 WHERE id=$1", [runId, snap.spentUsd]);
      await appendEvent(q, runId, status === "done" ? "run.completed" : "run.failed", {
        status: result.status, spentUsd: snap.spentUsd, completed: schedule.completed.length, failed: schedule.failed.length,
      });
      await setStatus(q, runId, status, { result, error: anyFailed ? "partial failure" : undefined });
    });
  }

  /** Після завершення задачі — людський підсумок у ту саму розмову. */
  async function finalizeConversation(runId: string, tenantId: string) {
    const run = await db.tx(tenantId, (q) => getRun(q, runId));
    if (!run || !(run as any).conversation_id) return;
    const convId = (run as any).conversation_id as string;

    const { rows: tasks } = await db.tx(tenantId, (q) => q<any>(
      "SELECT status, goal FROM tasks WHERE run_id=$1", [runId]));
    const result = (run.result ?? {}) as any;
    const findings: string[] = Array.isArray(result?.data?.findings) ? result.data.findings : [];
    const handoff = await db.tx(tenantId, (q) => getPendingHandoff(q, runId));

    const messageId = `msg_fin_${Date.now().toString(36)}`;
    bus.publish(convId, { type: "message.start", messageId, role: "assistant", meta: { intent: "result", runId } });
    let reply = "";
    for await (const chunk of streamFinale(llm, {
      request: run.prompt, status: run.status,
      summary: String(result?.summary ?? ""), findings,
      handoffQuestion: handoff?.question ?? null,
    })) {
      reply += chunk;
      bus.publish(convId, { type: "message.delta", messageId, text: chunk });
    }
    if (!reply.trim()) reply = run.status === "done" ? `Готово. ${result?.summary ?? ""}` : `Задача зупинилась: ${result?.summary ?? run.status}`;

    await db.tx(tenantId, (q) => addMessage(q, {
      tenantId, conversationId: convId, role: "assistant", content: reply, runId,
      meta: { intent: "result", status: run.status, tasks: tasks.length, handoff: handoff?.id ?? null },
    }));
    bus.publish(convId, { type: "message.done", messageId: `msg_fin_${Date.now().toString(36)}`, content: reply });
    await db.tx(tenantId, (q) => appendEvent(q, runId, "answer.ready", { conversationId: convId, chars: reply.length })).catch(() => {});
  }

  const launch = (runId: string, tenantId: string, opts: { resume?: boolean } = {}) => {
    const p = execute(runId, tenantId, opts)
      .catch(async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        await db.tx(tenantId, async (q) => {
          await appendEvent(q, runId, "run.failed", { error: msg }).catch(() => {});
          await setStatus(q, runId, "failed", { error: msg }).catch(() => {});
        }).catch(() => {});
      })
      .then(() => finalizeConversation(runId, tenantId).catch(() => {}))
      .finally(() => { const i = pending.indexOf(p); if (i >= 0) pending.splice(i, 1); });
    pending.push(p);
  };

  return {
    enqueue(runId, tenantId) { launch(runId, tenantId); },
    resume(runId, tenantId) { launch(runId, tenantId, { resume: true }); },
    async drain() { while (pending.length) await Promise.allSettled([...pending]); },
  };
}
