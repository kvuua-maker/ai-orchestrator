"use client";
import { useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Ev = { seq: number; type: string; payload?: any };

export default function Home() {
  const [prompt, setPrompt] = useState("Перевір https://example.com і зроби висновок");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState("idle");
  const [meta, setMeta] = useState<any>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => { fetch(`${API}/v1/meta`).then((r) => r.json()).then(setMeta).catch(() => {}); }, []);

  async function start() {
    setEvents([]); setStatus("starting");
    const res = await fetch(`${API}/v1/runs`, {
      method: "POST", headers: { "content-type": "application/json", "x-tenant-id": "tnt_demo0001" },
      body: JSON.stringify({ prompt }),
    });
    const body = await res.json();
    const id = body.run.id; setRunId(id); setStatus(body.run.status);
    esRef.current?.close();
    const es = new EventSource(`${API}/v1/runs/${id}/stream`);
    esRef.current = es;
    es.onmessage = () => {};
    ["run.created","plan.created","task.started","tool.called","tool.result","task.finished","run.completed","run.failed","end"].forEach((t) =>
      es.addEventListener(t, (e: any) => {
        if (t === "end") { setStatus("done"); es.close(); return; }
        setEvents((prev) => [...prev, JSON.parse(e.data)]);
      }));
    es.onerror = () => { es.close(); setStatus("stream closed"); };
  }

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>AI Orchestrator</h1>
      <p style={{ color: "#8b93a7", fontSize: 13, marginTop: 0 }}>
        walking skeleton · api {meta?.api_version ?? "…"} · polling {String(meta?.features?.polling ?? "…")}
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Що зробити?"
          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #232838", background: "#12151d", color: "#e6e8ee" }} />
        <button onClick={start} style={{ padding: "10px 16px", borderRadius: 8, border: 0, background: "#4f7cff", color: "#fff", cursor: "pointer" }}>Запустити</button>
      </div>
      {runId && <p style={{ fontSize: 12, color: "#8b93a7" }}>run {runId} · статус: {status}</p>}
      <div style={{ marginTop: 16, display: "grid", gap: 6 }}>
        {events.map((e) => (
          <div key={e.seq} style={{ fontSize: 13, padding: "8px 10px", borderRadius: 6, background: "#12151d", borderLeft: "3px solid #4f7cff" }}>
            <b>{e.type}</b> <span style={{ color: "#8b93a7" }}>#{e.seq}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
