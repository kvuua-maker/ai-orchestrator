"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { api, API, H, STATUS_LABEL } from "./lib";
import { Shell } from "./components/ui";

type Msg = { id: string; role: "user" | "assistant" | "system"; content: string; run_id?: string | null; meta?: any; created_at: string };
type Conv = { id: string; title: string; updated_at: string; last_message?: string; messages?: number };

const SUGGESTIONS = [
  "Що ти вмієш?",
  "Перевір https://example.com і зроби висновок",
  "Розпізнай чек і зроби таблицю витрат",
  "Як ти працюєш з документами?",
];

export default function ChatPage() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadConvs = useCallback(async () => {
    try { const d = await api<{ items: Conv[] }>("/v1/conversations"); setConvs(d.items); return d.items; }
    catch { return []; }
  }, []);

  const openConv = useCallback(async (id: string) => {
    setConvId(id); setError(null);
    try {
      const d = await api<{ conversation: Conv; messages: Msg[] }>(`/v1/conversations/${id}`);
      setMsgs(d.messages);
    } catch (e: any) { setError(e.message); }
  }, []);

  const newConv = useCallback(async () => {
    const d = await api<{ conversation: Conv }>("/v1/conversations", { method: "POST", body: JSON.stringify({}) });
    setConvs((c) => [d.conversation, ...c]);
    setConvId(d.conversation.id); setMsgs([]); setSidebar(false);
    return d.conversation.id;
  }, []);

  useEffect(() => {
    (async () => {
      const items = await loadConvs();
      const last = items[0]?.id;
      if (last) await openConv(last); else await newConv();
    })();
  }, [loadConvs, openConv, newConv]);

  // SSE: підсумки задач приходять сюди
  useEffect(() => {
    if (!convId) return;
    esRef.current?.close();
    const es = new EventSource(`${API}/v1/conversations/${convId}/stream`, {} as any);
    es.addEventListener("message.created", (e: any) => {
      const m: Msg = JSON.parse(e.data);
      setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      if (m.role === "assistant") { setBusyRun(null); setThinking(false); }
    });
    es.onerror = () => es.close();
    esRef.current = es;
    return () => es.close();
  }, [convId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, thinking]);

  async function send(override?: string) {
    const value = (override ?? text).trim();
    if (!value || thinking) return;
    let cid = convId;
    if (!cid) cid = await newConv();
    setText(""); setError(null); setThinking(true);
    const tempUser: Msg = { id: `tmp-${Date.now()}`, role: "user", content: value, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, tempUser]);
    try {
      const r = await api<{ assistantMessage: { id: string; content: string; meta: any }; runId: string | null; intent: string }>(
        `/v1/conversations/${cid}/messages`, { method: "POST", body: JSON.stringify({ text: value }) });
      setMsgs((m) => [...m, { id: r.assistantMessage.id, role: "assistant", content: r.assistantMessage.content, meta: r.assistantMessage.meta, run_id: r.runId, created_at: new Date().toISOString() }]);
      setThinking(false);
      if (r.runId) setBusyRun(r.runId);
      loadConvs();
    } catch (e: any) {
      setThinking(false);
      setError(e.status === 402 ? "Квоту вичерпано. Перейдіть на інший тариф на сторінці «Тариф»." : e.message);
    }
  }

  return (
    <Shell>
      <div style={{ display: "grid", gridTemplateColumns: sidebar ? "240px 1fr" : "0 1fr", gap: 16, alignItems: "start" }}>
        {/* список розмов */}
        <aside style={{ display: sidebar ? "block" : "none", borderRight: "1px solid #1c2130", paddingRight: 12 }}>
          <button onClick={newConv} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px dashed #2a3145", background: "transparent", color: "#c7ccd8", cursor: "pointer", fontSize: 13, marginBottom: 10 }}>
            + Нова розмова
          </button>
          <div style={{ display: "grid", gap: 4 }}>
            {convs.map((c) => (
              <button key={c.id} onClick={() => openConv(c.id)} style={{
                textAlign: "left", padding: "8px 10px", borderRadius: 7, border: 0, cursor: "pointer",
                background: c.id === convId ? "#181d29" : "transparent", color: c.id === convId ? "#e6e8ee" : "#8b93a7", fontSize: 12,
              }}>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</div>
                <div style={{ fontSize: 10, color: "#4d5568", marginTop: 2 }}>{c.messages ?? 0} повідомлень</div>
              </button>
            ))}
          </div>
        </aside>

        <section style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <button onClick={() => setSidebar((s) => !s)} style={{ background: "transparent", border: "1px solid #232838", color: "#8b93a7", borderRadius: 7, padding: "5px 9px", cursor: "pointer", fontSize: 12 }}>☰</button>
            <div>
              <h1 style={{ fontSize: 18, margin: 0 }}>AI Orchestrator</h1>
              <p style={{ fontSize: 11, color: "#5f677a", margin: "2px 0 0" }}>опишіть задачу звичайною мовою — я складу план і виконаю</p>
            </div>
          </div>

          <div style={{ minHeight: 380, maxHeight: "62vh", overflowY: "auto", padding: "4px 2px" }}>
            {msgs.length === 0 && !thinking && (
              <div style={{ textAlign: "center", padding: "36px 12px" }}>
                <div style={{ fontSize: 30, opacity: 0.5 }}>◍</div>
                <div style={{ fontSize: 15, marginTop: 10 }}>Привіт! Я ваш цифровий помічник.</div>
                <div style={{ fontSize: 12, color: "#8b93a7", marginTop: 6, maxWidth: 460, marginInline: "auto", lineHeight: 1.6 }}>
                  Можу перевірити сайти, розпізнати чеки й накладні, зробити таблицю чи звіт і запам'ятати контекст.
                  Просто напишіть, що потрібно.
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginTop: 16 }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} style={{ fontSize: 12, padding: "7px 12px", borderRadius: 99, border: "1px solid #232838", background: "#12151d", color: "#c7ccd8", cursor: "pointer" }}>{s}</button>
                  ))}
                </div>
              </div>
            )}

            {msgs.map((m) => <Bubble key={m.id} msg={m} onPick={send} />)}

            {thinking && <Typing />}
            {busyRun && !thinking && (
              <div style={{ fontSize: 11, color: "#5f677a", margin: "8px 0 0 44px" }}>
                виконую задачу… результат з'явиться тут автоматично
              </div>
            )}
            <div ref={endRef} />
          </div>

          {error && <div style={{ margin: "10px 0", padding: "9px 12px", borderRadius: 8, background: "#2a1518", border: "1px solid #5a2530", color: "#ff9b9b", fontSize: 12 }}>{error}</div>}

          <div style={{ display: "flex", gap: 8, marginTop: 10, background: "#12151d", border: "1px solid #232838", borderRadius: 12, padding: 8 }}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Напишіть повідомлення…"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              style={{ flex: 1, resize: "none", border: 0, outline: "none", background: "transparent", color: "#e6e8ee", fontSize: 14, padding: "8px 6px", fontFamily: "inherit", maxHeight: 120 }} />
            <button onClick={() => send()} disabled={thinking || !text.trim()} style={{
              padding: "8px 16px", borderRadius: 8, border: 0, background: thinking || !text.trim() ? "#2a3145" : "#4f7cff",
              color: "#fff", cursor: thinking ? "default" : "pointer", fontSize: 13, alignSelf: "flex-end",
            }}>{thinking ? "…" : "Надіслати"}</button>
          </div>
          <div style={{ fontSize: 10, color: "#3f4759", marginTop: 6, textAlign: "center" }}>
            Enter — надіслати · Shift+Enter — новий рядок · агент пам'ятає контекст розмови
          </div>
        </section>
      </div>
    </Shell>
  );
}

function Typing() {
  return (
    <div style={{ display: "flex", gap: 10, margin: "10px 0" }}>
      <Avatar />
      <div style={{ background: "#12151d", border: "1px solid #232838", borderRadius: "14px 14px 14px 4px", padding: "12px 16px" }}>
        <span style={{ display: "inline-flex", gap: 4 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{
              width: 6, height: 6, borderRadius: 99, background: "#5f677a",
              animation: `blink 1.2s ${i * 0.18}s infinite ease-in-out`,
            }} />
          ))}
        </span>
        <style>{`@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}`}</style>
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <div style={{ width: 30, height: 30, borderRadius: 9, background: "linear-gradient(135deg,#4f7cff,#7a5cff)", flexShrink: 0, display: "grid", placeItems: "center", fontSize: 13, color: "#fff" }}>◍</div>
  );
}

function Bubble({ msg, onPick }: { msg: Msg; onPick: (v: string) => void }) {
  const mine = msg.role === "user";
  const options: string[] = msg.meta?.options ?? [];
  const plan: string[] = msg.meta?.plan ?? [];
  return (
    <div style={{ display: "flex", gap: 10, margin: "10px 0", flexDirection: mine ? "row-reverse" : "row" }}>
      {!mine && <Avatar />}
      <div style={{ maxWidth: "78%", minWidth: 0 }}>
        <div style={{
          background: mine ? "#1d3a8a" : "#12151d",
          border: `1px solid ${mine ? "#2a4aa8" : "#232838"}`,
          borderRadius: mine ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
          padding: "11px 14px", fontSize: 14, lineHeight: 1.62, wordBreak: "break-word",
        }}>
          {mine ? <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span> : <MarkdownView text={msg.content} />}

          {plan.length > 0 && (
            <div style={{ marginTop: 10, padding: "9px 11px", borderRadius: 8, background: "#0e1117", border: "1px solid #232838" }}>
              <div style={{ fontSize: 11, color: "#7d879c", marginBottom: 5, textTransform: "uppercase", letterSpacing: .4 }}>План</div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#c7ccd8", lineHeight: 1.7 }}>
                {plan.map((p, i) => <li key={i}>{p}</li>)}
              </ol>
            </div>
          )}
        </div>

        {options.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {options.map((o) => (
              <button key={o} onClick={() => onPick(o)} style={{
                fontSize: 12, padding: "7px 12px", borderRadius: 99, border: "1px solid #2a4aa8",
                background: "#14204a", color: "#b9c9ff", cursor: "pointer",
              }}>{o}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: "#7aa2ff" }}>{children}</a>,
          code: ({ children }) => <code style={{ background: "#0e1117", padding: "2px 5px", borderRadius: 4, fontSize: 12.5 }}>{children}</code>,
          ul: ({ children }) => <ul style={{ margin: "6px 0", paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "6px 0", paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: "3px 0" }}>{children}</li>,
          p: ({ children }) => <p style={{ margin: "6px 0" }}>{children}</p>,
          strong: ({ children }) => <strong style={{ color: "#fff" }}>{children}</strong>,
          h1: ({ children }) => <h3 style={{ margin: "8px 0 4px", fontSize: 16 }}>{children}</h3>,
          h2: ({ children }) => <h4 style={{ margin: "8px 0 4px", fontSize: 15 }}>{children}</h4>,
          h3: ({ children }) => <h5 style={{ margin: "8px 0 4px", fontSize: 14 }}>{children}</h5>,
          table: ({ children }) => <table style={{ borderCollapse: "collapse", margin: "8px 0", fontSize: 12.5 }}>{children}</table>,
          th: ({ children }) => <th style={{ border: "1px solid #232838", padding: "5px 9px", textAlign: "left" }}>{children}</th>,
          td: ({ children }) => <td style={{ border: "1px solid #232838", padding: "5px 9px" }}>{children}</td>,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}
