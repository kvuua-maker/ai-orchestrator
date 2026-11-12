/** Метрики в пам'яті + експорт у формат Prometheus (§22.2). */
type Labels = Record<string, string | number>;

const keyOf = (name: string, labels?: Labels) =>
  labels && Object.keys(labels).length
    ? `${name}{${Object.entries(labels).sort().map(([k, v]) => `${k}="${v}"`).join(",")}}`
    : name;

export class Metrics {
  private counters = new Map<string, number>();
  private samples = new Map<string, number[]>();
  private readonly maxSamples: number;

  constructor(maxSamples = 1000) { this.maxSamples = maxSamples; }

  inc(name: string, labels?: Labels, by = 1): void {
    const k = keyOf(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const k = keyOf(name, labels);
    const arr = this.samples.get(k) ?? [];
    arr.push(value);
    if (arr.length > this.maxSamples) arr.shift();
    this.samples.set(k, arr);
  }

  private pct(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i]!;
  }

  histogram(): Array<{ name: string; count: number; p50: number; p95: number; p99: number; max: number }> {
    return [...this.samples.entries()].map(([name, values]) => {
      const s = [...values].sort((a, b) => a - b);
      return {
        name, count: s.length,
        p50: Math.round(this.pct(s, 50)), p95: Math.round(this.pct(s, 95)),
        p99: Math.round(this.pct(s, 99)), max: Math.round(s.at(-1) ?? 0),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  snapshot() {
    return { counters: Object.fromEntries([...this.counters].sort(([a], [b]) => a.localeCompare(b))), histograms: this.histogram() };
  }

  prometheus(): string {
    const lines: string[] = [];
    for (const [k, v] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
      const name = k.split("{")[0]!;
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${k} ${v}`);
    }
    for (const h of this.histogram()) {
      const name = h.name.split("{")[0]!;
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${h.name}_p50 ${h.p50}`);
      lines.push(`${h.name}_p95 ${h.p95}`);
      lines.push(`${h.name}_p99 ${h.p99}`);
      lines.push(`${h.name}_count ${h.count}`);
    }
    return lines.join("\n") + "\n";
  }

  reset(): void { this.counters.clear(); this.samples.clear(); }
}

export const metrics = new Metrics();
