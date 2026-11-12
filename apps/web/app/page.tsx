"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { api, API, H, STATUS_LABEL } from "./lib";

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
  const [streaming, setStreaming] = useState<{ id: string; text: string } | null>(null);
  const [steps, setSteps] = useState<Array<{ label: string; status: string; icon?: string }>>([]);
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
    es.addEventListener("message.start", (e: any) => {
      const d = JSON.parse(e.data);
      setThinking(false);
      setStreaming({ id: d.messageId, text: "" });
    });
    es.addEventListener("message.delta", (e: any) => {
      const d = JSON.parse(e.data);
      setStreaming((s) => ({ id: d.messageId, text: (s && s.id === d.messageId ? s.text : "") + d.text }));
    });
    es.addEventListener("message.done", (e: any) => {
      const d = JSON.parse(e.data);
      setStreaming(null);
      setMsgs((prev) => (prev.some((x) => x.id === d.messageId) ? prev
        : [...prev, { id: d.messageId, role: "assistant", content: d.content, meta: d.meta, created_at: new Date().toISOString() }]));
      setBusyRun(null);
    });
    es.addEventListener("step", (e: any) => {
      const d = JSON.parse(e.data);
      setSteps((prev) => {
        const next = [...prev];
        const i = next.findIndex((x) => x.label === d.label);
        if (i >= 0) next[i] = { label: d.label, status: d.status, icon: d.icon };
        else next.push({ label: d.label, status: d.status, icon: d.icon });
        return next;
      });
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
    setText(""); setError(null); setThinking(true); setSteps([]); setStreaming(null);
    const tempUser: Msg = { id: `tmp-${Date.now()}`, role: "user", content: value, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, tempUser]);
    try {
      const r = await api<{ messageId: string; content: string; runId: string | null; intent: string; plan?: string[]; options?: string[] }>(
        `/v1/conversations/${cid}/messages`, { method: "POST", body: JSON.stringify({ text: value }) });
      setMsgs((m) => (m.some((x) => x.id === r.messageId) ? m
        : [...m, { id: r.messageId, role: "assistant", content: r.content, meta: { intent: r.intent, plan: r.plan, options: r.options }, run_id: r.runId, created_at: new Date().toISOString() }]));
      setThinking(false); setStreaming(null);
      if (r.runId) setBusyRun(r.runId);
      loadConvs();
    } catch (e: any) {
      setThinking(false);
      setError(e.status === 402 ? "Квоту вичерпано. Перейдіть на інший тариф на сторінці «Тариф»." : e.message);
    }
  }

  return (
    <div className="chat-shell">
      <header className="shell-header">
        <div className="shell-inner">
          <button className="chat-toggle" onClick={() => setSidebar(true)} aria-label="Меню"
            style={{ background: "transparent", border: "1px solid #232838", color: "#8b93a7", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 14 }}>☰</button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>AI Orchestrator</div>
            <div style={{ fontSize: 11, color: "#5f677a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {busyRun ? "виконую задачу…" : "ваш цифровий помічник"}
            </div>
          </div>
          <button onClick={newConv} aria-label="Нова розмова"
            style={{ background: "#4f7cff", border: 0, color: "#fff", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }}>+ Нова</button>
        </div>
      </header>

      <div className="chat-body">
        {sidebar && <div className="chat-overlay" onClick={() => setSidebar(false)} />}
        <aside className={`chat-sidebar${sidebar ? " open" : ""}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: "#5f677a", textTransform: "uppercase", letterSpacing: .5 }}>Розмови</span>
            <button onClick={() => setSidebar(false)} aria-label="Закрити"
              style={{ background: "transparent", border: 0, color: "#8b93a7", fontSize: 18, cursor: "pointer" }}>×</button>
          </div>
          <button onClick={newConv} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px dashed #2a3145", background: "transparent", color: "#c7ccd8", cursor: "pointer", fontSize: 13 }}>
            + Нова розмова
          </button>
          <div style={{ display: "grid", gap: 4 }}>
            {convs.map((c) => (
              <button key={c.id} onClick={() => { openConv(c.id); setSidebar(false); }} style={{
                textAlign: "left", padding: "8px 10px", borderRadius: 7, border: 0, cursor: "pointer",
                background: c.id === convId ? "#181d29" : "transparent", color: c.id === convId ? "#e6e8ee" : "#8b93a7", fontSize: 12,
              }}>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</div>
                <div style={{ fontSize: 10, color: "#4d5568", marginTop: 2 }}>{c.messages ?? 0} повідомлень</div>
              </button>
            ))}
          </div>
        </aside>

        <section className="chat-main">
          <div className="chat-scroll">
            {msgs.length === 0 && !thinking && (
              <div style={{ textAlign: "center", padding: "28px 8px" }}>
                <div style={{ fontSize: 30, opacity: 0.5 }}>◍</div>
                <div style={{ fontSize: 15, marginTop: 10 }}>Привіт! Я ваш цифровий помічник.</div>
                <div style={{ fontSize: 12.5, color: "#8b93a7", marginTop: 6, maxWidth: 460, marginInline: "auto", lineHeight: 1.6 }}>
                  Можу перевірити сайти, розпізнати чеки й накладні, зробити таблицю чи звіт і запам'ятати контекст.
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
            {streaming && (
              <div className="bubble-row">
                <Avatar />
                <div className="bubble bubble-bot">
                  <MarkdownView text={streaming.text} />
                  <span style={{ display: "inline-block", width: 7, height: 15, background: "#4f7cff", marginLeft: 2, animation: "caret .9s steps(1) infinite", verticalAlign: "text-bottom" }} />
                  <style>{`@keyframes caret{50%{opacity:0}}`}</style>
                </div>
              </div>
            )}
            {steps.length > 0 && (
              <div style={{ margin: "2px 0 10px 38px", display: "grid", gap: 4 }}>
                {steps.map((s, i) => (
                  <div key={`${s.label}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: s.status === "failed" ? "#ff9b9b" : s.status === "running" ? "#8b93a7" : "#7fc9a6" }}>
                    <span style={{ width: 14, textAlign: "center", flexShrink: 0 }}>{s.icon ?? (s.status === "running" ? "⏳" : "✓")}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                  </div>
                ))}
              </div>
            )}
            {busyRun && !thinking && !streaming && (
              <div style={{ fontSize: 11, color: "#5f677a", margin: "6px 0 0 38px" }}>виконую задачу… результат з'явиться тут</div>
            )}
            <div ref={endRef} />
          </div>

          {error && <div style={{ margin: "6px 0", padding: "9px 12px", borderRadius: 8, background: "#2a1518", border: "1px solid #5a2530", color: "#ff9b9b", fontSize: 12 }}>{error}</div>}

          <div className="chat-composer">
            <div className="composer-box">
              <textarea className="composer-input" rows={1} value={text} placeholder="Напишіть повідомлення…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="composer-send" onClick={() => send()} disabled={thinking || !text.trim()}
                style={{ background: thinking || !text.trim() ? "#2a3145" : "#4f7cff", color: "#fff", cursor: thinking ? "default" : "pointer" }}>
                {thinking ? "…" : "Надіслати"}
              </button>
            </div>
            <div style={{ fontSize: 10, color: "#3f4759", marginTop: 5, textAlign: "center" }}>
              Enter — надіслати · агент пам'ятає контекст
            </div>
          </div>
        </section>
      </div>
    </div>
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
    <div className="bubble-row" style={{ flexDirection: mine ? "row-reverse" : "row" }}>
      {!mine && <Avatar />}
      <div className="bubble-wrap">
        <div className={`bubble ${mine ? "bubble-user" : "bubble-bot"}`}>
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
