import type { Plan, TaskNode, TaskResult } from "@aio/shared";

export interface ScheduleResult {
  results: Map<string, TaskResult>;
  completed: string[];
  failed: string[];
  skipped: string[];
}

export class CycleError extends Error {
  constructor() { super("plan has a cycle or dangling dependency"); this.name = "CycleError"; }
}

/**
 * Детермінований scheduler: виконує готові вузли паралельно (§3.3.2).
 * Провал вузла → усі залежні позначаються skipped, run не падає одразу.
 */
export async function runPlan(
  plan: Plan,
  runNode: (node: TaskNode) => Promise<TaskResult>,
  opts: { concurrency?: number; onSkip?: (node: TaskNode, reason: string) => Promise<void>;
          skipDone?: Set<string>; shouldStop?: () => boolean } = {},
): Promise<ScheduleResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const results = new Map<string, TaskResult>();
  const started = new Set<string>();
  const failed: string[] = [];
  const skipped: string[] = [];

  const total = plan.nodes.length;
  if (total === 0) return { results, completed: [], failed, skipped };

  if (opts.skipDone) for (const id of opts.skipDone) if (byId.has(id)) results.set(id, { status: "success", summary: "already done", artifacts: [], evidence: [], blockers: [], nextHints: [], metrics: { steps: 0, tokens: 0, costUsd: 0, durationMs: 0 } });

  for (let guard = 0; guard < total * 4; guard++) {
    if (opts.shouldStop?.()) break;
    const done = new Set([...results.keys(), ...failed, ...skipped]);
    if (done.size === total) break;

    const ready = plan.nodes.filter((n) =>
      !done.has(n.id) &&
      n.dependsOn.every((d) => results.has(d)) &&
      !n.dependsOn.some((d) => failed.includes(d) || skipped.includes(d)),
    );

    const blocked = plan.nodes.filter((n) =>
      !done.has(n.id) && n.dependsOn.some((d) => failed.includes(d) || skipped.includes(d)),
    );
    for (const n of blocked) {
      skipped.push(n.id);
      await opts.onSkip?.(n, "dependency failed");
    }

    if (!ready.length) {
      if (blocked.length) continue;
      throw new CycleError();
    }

    const batch = ready.slice(0, concurrency);
    const settled = await Promise.allSettled(batch.map(async (n) => {
      started.add(n.id);
      const res = await runNode(n);
      return { node: n, res };
    }));

    for (const [i, s] of settled.entries()) {
      const node = batch[i]!;
      if (s.status === "fulfilled") {
        results.set(node.id, s.value.res);
        if (s.value.res.status === "failed" || s.value.res.status === "blocked") failed.push(node.id);
      } else {
        failed.push(node.id);
        results.set(node.id, {
          status: "failed", summary: `error: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
          artifacts: [], evidence: [], blockers: [String(s.reason)], nextHints: [],
          metrics: { steps: 1, tokens: 0, costUsd: 0, durationMs: 0 },
        });
      }
    }
  }

  return { results, completed: [...results.keys()].filter((id) => !failed.includes(id)), failed, skipped };
}

/** Топологічні хвилі — для UI та оцінки критичного шляху. */
export function topoWaves(plan: Plan): string[][] {
  const waves: string[][] = [];
  const placed = new Set<string>();
  while (placed.size < plan.nodes.length) {
    const wave = plan.nodes.filter((n) => !placed.has(n.id) && n.dependsOn.every((d) => placed.has(d)));
    if (!wave.length) throw new CycleError();
    wave.forEach((n) => placed.add(n.id));
    waves.push(wave.map((n) => n.id));
  }
  return waves;
}
