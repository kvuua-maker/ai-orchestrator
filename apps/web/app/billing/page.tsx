"use client";
import { useEffect, useState } from "react";
import { api, fmtDate, TENANT } from "../lib";
import { Badge, Button, Card, Empty, ErrorNote, Progress, Shell, Skeleton, Stat } from "../components/ui";

type Plan = { id: string; name: string; price_usd: string; monthly_runs: number; monthly_tokens: number; max_concurrent: number; overage_per_1k_tokens: string };
type Quota = { plan: Plan; usage: { runs: number; tokens: number; costUsd: number; periodStart: string; periodEnd: string }; runsRemaining: number; tokensRemaining: number; allowed: boolean; reason?: string };
type Invoice = { id: string; period_start: string; amount_usd: string; status: string; lines: Array<{ description: string; amount_usd: number }> };

export default function BillingPage() {
  const [data, setData] = useState<{ quota: Quota; plans: Plan[] } | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<{ quota: Quota; plans: Plan[] }>("/v1/billing/plan").then(setData).catch((e) => setError(e.message));
    api<{ items: Invoice[] }>("/v1/billing/invoices").then((d) => setInvoices(d.items)).catch(() => setInvoices([]));
  };
  useEffect(load, []);

  async function choose(planId: string) {
    setBusy(true);
    try { await api("/v1/billing/plan", { method: "POST", body: JSON.stringify({ planId }) }); load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function makeInvoice() {
    setBusy(true);
    try { await api("/v1/billing/invoices", { method: "POST", body: JSON.stringify({}) }); load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const quota = data?.quota;
  const plans = data?.plans ?? [];
  const runsUsedPct = quota && quota.plan.monthly_runs ? (quota.usage.runs / quota.plan.monthly_runs) * 100 : 0;

  return (
    <Shell>
      <h1 style={{ fontSize: 20, margin: "0 0 16px" }}>Тариф і квоти</h1>

      {!data && !error && <Skeleton rows={4} />}
      {error && !data && <ErrorNote text={`Не вдалося завантажити тариф: ${error}`} />}

      {quota && (
        <>
          {!quota.allowed && (
            <div style={{ marginBottom: 14 }}>
              <ErrorNote text={`Квоту вичерпано (${quota.reason}). Наступний період почнеться ${fmtDate(quota.usage.periodEnd)} — або змініть тариф.`} />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 18 }}>
            <Stat label="Тариф" value={quota.plan.name} hint={Number(quota.plan.price_usd) === 0 ? "безкоштовно" : `$${quota.plan.price_usd}/міс`} />
            <Stat label="Запуски" value={`${quota.usage.runs} / ${quota.plan.monthly_runs}`} hint={`залишилось ${quota.runsRemaining}`} />
            <Stat label="Токени" value={`${(quota.usage.tokens / 1000).toFixed(1)}k / ${(quota.plan.monthly_tokens / 1000).toFixed(0)}k`} hint={`залишилось ${(quota.tokensRemaining / 1000).toFixed(1)}k`} />
            <Stat label="Витрачено" value={`$${quota.usage.costUsd.toFixed(4)}`} hint={`період до ${fmtDate(quota.usage.periodEnd)}`} />
          </div>

          <Card title="Використання запусків" hint={`${Math.round(runsUsedPct)}%`}>
            <Progress value={quota.usage.runs} max={quota.plan.monthly_runs} danger={!quota.allowed} />
            <div style={{ fontSize: 11, color: "#5f677a", marginTop: 8 }}>
              Тенант: {TENANT} · паралельних задач: до {quota.plan.max_concurrent} · перевитрата: ${quota.plan.overage_per_1k_tokens}/1k токенів
            </div>
          </Card>

          <h2 style={{ fontSize: 14, margin: "24px 0 10px" }}>Змінити тариф</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            {plans.map((p) => {
              const current = p.id === quota.plan.id;
              return (
                <Card key={p.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <b style={{ fontSize: 14 }}>{p.name}</b>
                    {current && <Badge label="поточний" color="#3ecf8e" />}
                  </div>
                  <div style={{ fontSize: 22, margin: "8px 0 4px" }}>{Number(p.price_usd) === 0 ? "Безкоштовно" : `$${p.price_usd}`}<span style={{ fontSize: 12, color: "#5f677a" }}>{Number(p.price_usd) ? "/міс" : ""}</span></div>
                  <ul style={{ fontSize: 12, color: "#8b93a7", paddingLeft: 16, margin: "8px 0 14px", lineHeight: 1.7 }}>
                    <li>{p.monthly_runs.toLocaleString("uk-UA")} запусків</li>
                    <li>{(p.monthly_tokens / 1000).toLocaleString("uk-UA")}k токенів</li>
                    <li>{p.max_concurrent} паралельно</li>
                  </ul>
                  <Button variant={current ? "ghost" : "primary"} disabled={current || busy} onClick={() => choose(p.id)}>
                    {current ? "Активний" : "Обрати"}
                  </Button>
                </Card>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "24px 0 10px" }}>
            <h2 style={{ fontSize: 14, margin: 0 }}>Інвойси</h2>
            <Button variant="ghost" disabled={busy} onClick={makeInvoice}>Виставити за поточний період</Button>
          </div>
          {invoices.length === 0 ? (
            <Empty title="Інвойсів ще немає" text="Інвойс формується з підписки та перевитрати токенів за період. Натисніть «Виставити», щоб створити перший." />
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {invoices.map((inv) => (
                <Card key={inv.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 13 }}>{inv.id}</div>
                      <div style={{ fontSize: 11, color: "#5f677a", marginTop: 3 }}>{fmtDate(inv.period_start)} · {inv.lines.length} рядк(ів)</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 15 }}>${Number(inv.amount_usd).toFixed(2)}</div>
                      <Badge label={inv.status} color={inv.status === "paid" ? "#3ecf8e" : "#ffb020"} />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
