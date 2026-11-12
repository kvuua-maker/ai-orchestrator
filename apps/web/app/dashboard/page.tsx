"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const H = { "x-tenant-id": "tnt_demo0001" };

type Summary = {
  window_hours: number;
  runs: { total: number; done: number; failed: number; by_status: Record<string, number> };
  success_rate: number;
  duration_ms: { p50: number; p95: number };
  cost_usd: number;
  handoffs: { pending: number; resolved: number };
  top_tools: Array<{ tool: string; calls: number }>;
  failing_tools: Array<{ tool: string; failures: number }>;
  process: { counters: Record<string, number>; histograms: Array<{ name: string; count: number; p50: number; p95: number; p99: number }> };
};

const Card = ({ label, value, hint }: { label: string; value: string | number; hint?: string }) => (
  <div style={{ padding: 16, borderRadius: 10, background: "#12151d", border: "1px solid #232838" }}>
    <div style={{ fontSize: 12, color: "#8b93a7" }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 600, marginTop: 6 }}>{value}</div>
    {hint && <div style={{ fontSize: 11, color: "#5f677a", marginTop: 4 }}>{hint}</div>}
  </div>
);

export default function Dashboard() {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/v1/observability/summary?hours=24`, { headers: H })
      .then((r) => r.json()).then(setS).catch((e) => setErr(String(e)));
  }, []);

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Observability</h1>
      <p style={{ color: "#8b93a7", fontSize: 13, marginTop: 0 }}>останні {s?.window_hours ?? 24} годин</p>
      {err && <p style={{ color: "#ff6b6b" }}>{err}</p>}
      {!s && !err && <p style={{ color: "#8b93a7" }}>завантаження…</p>}
      {s && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 16 }}>
            <Card label="Успішність" value={`${s.success_rate}%`} hint={`${s.runs.done} з ${s.runs.total}`} />
            <Card label="runs" value={s.runs.total} hint={`failed: ${s.runs.failed}`} />
            <Card label="p50 / p95" value={`${s.duration_ms.p50} / ${s.duration_ms.p95} мс`} />
            <Card label="Витрати" value={`$${s.cost_usd.toFixed(4)}`} />
            <Card label="Handoff" value={s.handoffs.pending} hint={`resolve: ${s.handoffs.resolved}`} />
          </div>

          <h2 style={{ fontSize: 16, marginTop: 28 }}>Статуси</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(s.runs.by_status).map(([k, v]) => (
              <span key={k} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, background: "#12151d", border: "1px solid #232838" }}>
                {k}: <b>{v}</b>
              </span>
            ))}
          </div>

          <h2 style={{ fontSize: 16, marginTop: 28 }}>Топ інструментів</h2>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <tbody>
              {s.top_tools.map((t) => (
                <tr key={t.tool}><td style={{ padding: "6px 0", color: "#c7ccd8" }}>{t.tool}</td><td style={{ textAlign: "right" }}>{t.calls}</td></tr>
              ))}
              {s.failing_tools.map((t) => (
                <tr key={`f-${t.tool}`}><td style={{ padding: "6px 0", color: "#ff8080" }}>{t.tool} (помилки)</td><td style={{ textAlign: "right", color: "#ff8080" }}>{t.failures}</td></tr>
              ))}
            </tbody>
          </table>

          <h2 style={{ fontSize: 16, marginTop: 28 }}>Процес</h2>
          <pre style={{ fontSize: 11, background: "#0e1117", padding: 12, borderRadius: 8, overflow: "auto", maxHeight: 220 }}>
            {JSON.stringify(s.process.histograms, null, 2)}
          </pre>
        </>
      )}
    </main>
  );
}
