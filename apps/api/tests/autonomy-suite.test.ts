import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { SCENARIOS } from "./autonomy/scenarios.js";
import { createHarness, summarise, type ScenarioOutcome } from "./autonomy/harness.js";

const H = { "x-tenant-id": "tnt_demo0001" };
let harness: ReturnType<typeof createHarness>;
let app: any;

beforeAll(async () => {
  harness = createHarness();
  const init = await harness.init();
  app = init.app;
  // чистий старт: квота free = 100 запусків/міс, нам треба 50
  await app.db.tx("tnt_demo0001", async (q: any) => {
    await q("INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1,'business','active') ON CONFLICT (tenant_id) DO UPDATE SET plan_id='business', status='active'", ["tnt_demo0001"]);
    await q("DELETE FROM usage_events WHERE tenant_id=$1 AND created_at >= date_trunc('month', now())", ["tnt_demo0001"]);
  });
});
afterAll(async () => { await app.close(); });

describe("Автономність на 50 сценаріях", () => {
  it("прогін і звіт", async () => {
    const outcomes: ScenarioOutcome[] = [];

    for (const s of SCENARIOS) {
      harness.setScenario(s);
      const t0 = Date.now();
      const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: s.prompt } });
      if (created.statusCode !== 201) {
        outcomes.push({ id: s.id, category: s.category, expect: s.expect, actual: `http_${created.statusCode}`,
          reason: created.json()?.error?.code ?? null, handedOff: false, correct: false, ms: Date.now() - t0, attempts: 0 });
        continue;
      }
      const id = created.json().run.id;
      await app.engine.drain();

      const view = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H })).json();
      const status = view.run.status;
      const handoff = view.handoff;
      const reason = handoff?.reason ?? view.run.error?.split(":")[0] ?? null;

      let correct = false;
      if (s.expect === "auto") correct = status === "done";
      else if (s.expect === "human" || s.expect === "limit") correct = status === "blocked" && handoff?.reason === s.expectReason;
      else if (s.expect === "fail") correct = status === "failed";

      outcomes.push({
        id: s.id, category: s.category, expect: s.expect, actual: status,
        reason, handedOff: !!handoff, correct, ms: Date.now() - t0, attempts: harness.attempts,
      });
    }

    const summary = summarise(outcomes);
    const failed = outcomes.filter((o) => !o.correct);

    // звіт для людей
    mkdirSync("docs", { recursive: true });
    const rows = outcomes.map((o) =>
      `| ${o.id} | ${o.category} | ${o.expect} | ${o.actual} | ${o.reason ?? "—"} | ${o.correct ? "✓" : "✗"} |`)
      .join("\n");
    const md = `# Автономність: вимірювання на 50 сценаріях

Дата: ${new Date().toISOString().slice(0, 10)}
Середовище: детерміновані моки інструментів, реальний Router (евристика) + Planner + Scheduler + Handoff.

## Підсумок

| Метрика | Значення |
|---|---|
| Автономне виконання (де очікувалось) | **${summary.autonomy.achieved}/${summary.autonomy.expected} = ${summary.autonomy.rate}%** |
| Коректна ескалація (handoff/межа) | ${summary.escalation.correct}/${summary.escalation.expected} = ${summary.escalation.rate}% |
| Коректне падіння (глухий кут) | ${summary.deadEnds.correct}/${summary.deadEnds.expected} = ${summary.deadEnds.rate}% |
| Загальна правильність рішення | ${summary.overall.correct}/${summary.total} = ${summary.overall.rate}% |
| Середній час сценарію | ${summary.avgMs} мс |

## Деталі

| ID | Категорія | Очікування | Факт | Причина | ✓ |
|---|---|---|---|---|---|
${rows}

## Обмеження цього виміру

- Моки інструментів: перевіряється **логіка рушія** (маршрутизація, планування, ретраї, класифікація, handoff),
  а не якість живої LLM-моделі чи реальних сайтів.
- Реальна автономність із DeepSeek буде **нижчою**: план від моделі може бути некоректним,
  а зовнішні сайти — змінюватись.
- Цифра ${summary.autonomy.rate}% означає: «рушій не заважає виконати задачу там, де це можливо».
`;
    writeFileSync("docs/autonomy-report.md", md, "utf8");

    console.log("\n=== АВТОНОМНІСТЬ ===");
    console.log(`авто: ${summary.autonomy.achieved}/${summary.autonomy.expected} = ${summary.autonomy.rate}%`);
    console.log(`ескалація: ${summary.escalation.correct}/${summary.escalation.expected} = ${summary.escalation.rate}%`);
    console.log(`глухі кути: ${summary.deadEnds.correct}/${summary.deadEnds.expected} = ${summary.deadEnds.rate}%`);
    console.log(`разом правильно: ${summary.overall.correct}/${summary.total} = ${summary.overall.rate}%`);
    if (failed.length) console.log("провали:", failed.map((f) => `${f.id}(${f.expect}→${f.actual}/${f.reason})`).join(", "));

    expect(summary.overall.rate).toBeGreaterThanOrEqual(90);   // поріг якості рушія
  }, 180_000);
});
