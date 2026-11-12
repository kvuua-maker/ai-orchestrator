export class BudgetExceeded extends Error {
  constructor(readonly spent: number, readonly limit: number) {
    super(`budget exceeded: spent $${spent.toFixed(4)} of $${limit.toFixed(4)}`);
    this.name = "BudgetExceeded";
  }
}

export interface BudgetSnapshot {
  limitUsd: number;
  spentUsd: number;
  pct: number;
  remainingUsd: number;
  exhausted: boolean;
}

/** Бюджет run'а: попередня перевірка + списання (§7.6.3, §3.3). */
export class BudgetGuard {
  private spent = 0;
  private warned = false;

  constructor(readonly limitUsd: number, private readonly onWarning?: (s: BudgetSnapshot) => void) {}

  canAfford(estimateUsd: number): boolean {
    return this.spent + estimateUsd <= this.limitUsd;
  }

  /** Кидає BudgetExceeded — виклик зупиняється graceful, частковий результат зберігається. */
  charge(actualUsd: number): BudgetSnapshot {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error("charge must be a non-negative finite number");
    this.spent += actualUsd;
    const snap = this.snapshot();
    if (!this.warned && snap.pct >= 80) { this.warned = true; this.onWarning?.(snap); }
    if (this.spent > this.limitUsd) throw new BudgetExceeded(this.spent, this.limitUsd);
    return snap;
  }

  snapshot(): BudgetSnapshot {
    const pct = this.limitUsd <= 0 ? 100 : Math.round((this.spent / this.limitUsd) * 1000) / 10;
    return {
      limitUsd: this.limitUsd, spentUsd: Math.round(this.spent * 1e6) / 1e6, pct,
      remainingUsd: Math.max(0, Math.round((this.limitUsd - this.spent) * 1e6) / 1e6),
      exhausted: this.spent > this.limitUsd,
    };
  }
}
