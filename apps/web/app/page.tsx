"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, API, H, STATUS_LABEL, TENANT } from "./lib";
import { Badge, Button, Card, Empty, ErrorNote, Shell } from "./components/ui";

type Ev = { seq: number; type: string; payload?: any };
type Handoff = { id: string; reason: string; question: string; options: Array<{ id: string; label: string }> };

const EXAMPLES = [
  "Розпізнай чек із Сільпо і зроби таблицю витрат",
  "Перевір https://example.com і зроби короткий висновок",
  "Порівняй ціни на https://a.example і https://b.example",
];

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [events, setEvents] = useState<Ev[]>([]);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => () => esRef.current?.close(), []);

  async function start(text?: string) {
    const p = (text ?? prompt).trim();
    if (!p) return;
    setBusy(true); setError(null); setEvents([]); setHandoff(null); setStatus("starting");
    try {
      const body = await api<{ run: { id: string; status: string } }>("/v1/runs", { method: "POST", body: JSON.stringify({ prompt: p }) });
      const id = body.run.id;
      setRunId(id); setStatus(body.run.status);
      esRef.current?.close();
      const es = new EventSource(`${API}/v1/runs/${id}/stream`, {} as any);
      esRef.current = es;
      ["run.created","plan.created","task.started","tool.called","tool.result","task.finished","task.skipped","handoff.requested","run.blocked","run.completed","run.failed"].forEach((t) =>
        es.addEventListener(t, (e: any) => {
          const data = JSON.parse(e.data ?? "{}");
          setEvents((prev) => [...prev, { seq: data.seq, type: t, payload: data.payload }]);
          if (t === "handoff.requested") setHandoff({ id: data.payload.handoffId, reason: data.payload.reason, question: data.payload.question, options: data.payload.options ?? [] });
          if (t === "run.blocked") setStatus("blocked");
          if (t === "run.completed") { setStatus("done"); es.close(); }
          if (t === "run.failed") { setStatus("failed"); es.close(); }
        }));
      es.addEventListener("end", () => { es.close(); });
      es.onerror = () => { es.close(); };
    } catch (e: any) {
      if (e.status === 402) setError(`Квоту вичерпано. ${e.message}`);
      else setError(e.message);
    } finally { setBusy(false); }
  }

  async function resolve(option: string) {
    if (!handoff) return;
    try {
      await api(`/v1/handoffs/${handoff.id}/resolve`, { method: "POST", body: JSON.stringify({ option }) });
      setHandoff(null); setStatus("running");
    } catch (e: any) { setError(e.message); }
  }

  const [label, color] = STATUS_LABEL[status] ?? [status, "#8b93a7"];

  return (
    <Shell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Що зробити?</h1>
          <p style={{ fontSize: 12, color: "#5f677a", margin: "4px 0 0" }}>Опишіть задачу звичайною мовою — агент складе план і виконає його.</p>
        </div>
        {runId && <Badge label={label} color={color} />}
      </div>

      <Card>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Наприклад: розпізнай чек і зроби таблицю витрат за листопад"
          rows={3} style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 12, borderRadius: 8, border: "1px solid #232838", background: "#0e1117", color: "#e6e8ee", fontSize: 13, fontFamily: "inherit" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => { setPrompt(ex); start(ex); }} style={{
                fontSize: 11, padding: "5px 10px", borderRadius: 99, border: "1px solid #232838",
                background: "transparent", color: "#8b93a7", cursor: "pointer",
              }}>{ex.length > 42 ? ex.slice(0, 40) + "…" : ex}</button>
            ))}
          </div>
          <Button onClick={() => start()} disabled={busy || !prompt.trim()}>{busy ? "Запуск…" : "Запустити"}</Button>
        </div>
      </Card>

      {error && <div style={{ marginTop: 12 }}><ErrorNote text={error} /></div>}

      {handoff && (
        <div style={{ marginTop: 14, padding: 16, borderRadius: 12, background: "#241b0a", border: "1px solid #5a4318" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Потрібна ваша участь · {handoff.reason}</div>
          <p style={{ fontSize: 13, color: "#e8d5a8", margin: "8px 0 12px", lineHeight: 1.6 }}>{handoff.question}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {handoff.options.map((o) => <Button key={o.id} variant={o.id === "done" ? "primary" : "ghost"} onClick={() => resolve(o.id)}>{o.label}</Button>)}
          </div>
        </div>
      )}

      {events.length === 0 && !busy && !runId && (
        <div style={{ marginTop: 18 }}>
          <Empty title="Тут з'явиться хід виконання" text="Кожен крок агента — окрема подія: план, виклик інструмента, результат. Якщо агент застрягне, він запитає вас прямо на цій сторінці." />
        </div>
      )}

      {events.length > 0 && (
        <div style={{ marginTop: 18, display: "grid", gap: 6 }}>
          {events.map((e) => (
            <div key={e.seq} style={{ fontSize: 12, padding: "8px 12px", borderRadius: 7, background: "#12151d", borderLeft: `3px solid ${e.type.includes("fail") || e.type.includes("blocked") ? "#ff6b6b" : e.type.includes("handoff") ? "#ffb020" : "#4f7cff"}` }}>
              <b>{e.type}</b> <span style={{ color: "#5f677a" }}>#{e.seq}</span>
              {e.payload?.goal && <span style={{ color: "#8b93a7" }}> · {e.payload.goal}</span>}
              {e.payload?.summary && <span style={{ color: "#8b93a7" }}> · {e.payload.summary}</span>}
            </div>
          ))}
        </div>
      )}

      {status === "done" && runId && (
        <div style={{ marginTop: 14, fontSize: 12, color: "#5f677a" }}>
          Запуск {runId} завершено. <Link href="/runs" style={{ color: "#4f7cff", textDecoration: "none" }}>Усі запуски →</Link>
        </div>
      )}
    </Shell>
  );
}
