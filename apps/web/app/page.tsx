"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { api, API, H, STATUS_LABEL, TENANT } from "./lib";

type Msg = { id: string; role: "user" | "assistant" | "system"; content: string; run_id?: string | null; meta?: any; created_at: string };
type Conv = { id: string; title: string; updated_at: string; last_message?: string; messages?: number };

/** Виправляє типові помилки браузерного розпізнавання української мови. */
function fixTranscript(raw: string): string {
  return raw
    .replace(/\bес\s*е\b/gi, "SE")
    .replace(/\bесе\b/gi, "SE")
    .replace(/\bпро\s*макс\b/gi, "Pro Max")
    .replace(/\bпро\b/gi, "Pro")
    .replace(/\bплюс\b/gi, "Plus")
    .replace(/\bміні\b/gi, "mini")
    .replace(/\bаи?фон\b/gi, "iPhone")
    .replace(/\bайфон\b/gi, "iPhone")
    .replace(/\b(\d{2,4})\s*(гігабайт\w*|гб)\b/gi, "$1 ГБ")
    .replace(/\s{2,}/g, " ");
}

function speak(msg: { content: string }) {
  const synth = (window as any).speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(msg.content.replace(/[*_`#>-]/g, " ").slice(0, 600));
  u.lang = "uk-UA"; u.rate = 1.02;
  synth.speak(u);
}

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
  const [runStart, setRunStart] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(Date.now());
  const runSeconds = busyRun && runStart ? Math.max(0, Math.floor((nowTs - runStart) / 1000)) : 0;
  const [stopping, setStopping] = useState(false);
  const [handoff, setHandoff] = useState<{ id: string; question: string; options: Array<{ id: string; label: string }> } | null>(null);
  const [manual, setManual] = useState("");
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakOut, setSpeakOut] = useState(true);
  const [proactive, setProactive] = useState<Array<{ label: string; text: string }>>([]);
  const recRef = useRef<any>(null);
  const micLevelRef = useRef(0);
  const [micLevel, setMicLevel] = useState(0);
  const [micSeconds, setMicSeconds] = useState(0);
  const [preview, setPreview] = useState("");
  const sseAlive = useRef(false);
  const pollTimer = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
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
    api<{ suggestions: Array<{ label: string; text: string }> }>("/v1/proactive")
      .then((d) => setProactive(d.suggestions ?? [])).catch(() => setProactive([]));
  }, []);

  useEffect(() => {
    (async () => {
      const items = await loadConvs();
      const last = items[0]?.id;
      if (last) await openConv(last); else await newConv();
    })();
  }, [loadConvs, openConv, newConv]);

  // SSE через fetch: EventSource не передає Basic Auth, тому стрім мовчки падав на 401
  useEffect(() => {
    if (!convId) return;
    const ctrl = new AbortController();
    let stopped = false;
    const handle = (type: string, d: any) => {
      if (type === "message.created") {
        const m: Msg = d;
        setMsgs((prev) => {
          if (prev.some((x) => x.id === m.id)) return prev;
          if (m.role === "user") {
            const i = prev.findIndex((x) => x.id.startsWith("tmp-") && x.content === m.content);
            if (i >= 0) { const copy = [...prev]; copy[i] = m; return copy; }
          }
          return [...prev, m];
        });
        setThinking(false);
        // busyRun НЕ чіпаємо: plan-повідомлення зберігається одразу, а задача ще виконується
      } else if (type === "message.start") {
        sseAlive.current = true;
        setThinking(false);
        setStreaming({ id: d.messageId, text: "" });
        // якщо за 12 с не прийшло жодного символу — не показуємо порожній блок
        setTimeout(() => {
          setStreaming((cur) => {
            if (cur && cur.id === d.messageId && !cur.text) {
              setError("Не вдалося отримати текст відповіді. Спробуйте ще раз.");
              return null;
            }
            return cur;
          });
        }, 12_000);
        setSteps((prev) => prev.filter((x) => !x.label.startsWith("Думаю над планом")));
      } else if (type === "message.delta") {
        setStreaming((prev) => ({ id: d.messageId, text: (prev && prev.id === d.messageId ? prev.text : "") + d.text }));
      } else if (type === "message.done") {
        setStreaming(null);
        setMsgs((prev) => (prev.some((x) => x.id === d.messageId) ? prev
          : [...prev, { id: d.messageId, role: "assistant", content: d.content, meta: d.meta, created_at: new Date().toISOString() }]));
        // завершуємо стан лише коли прийшов ПІДСУМОК задачі, а не план
        if (d?.meta?.intent === "result") {
          setBusyRun(null); setRunStart(null);
          setSteps((prev) => prev.map((x) => x.status === "running" ? { ...x, status: "done", icon: "✓" } : x));
        }
      } else if (type === "step") {
        setSteps((prev) => {
          const next = [...prev];
          const i = next.findIndex((x) => x.label.replace(/ · \d+ с$/, "") === d.label.replace(/ · \d+ с$/, ""));
          if (i >= 0) next[i] = { label: d.label, status: d.status, icon: d.icon };
          else next.push({ label: d.label, status: d.status, icon: d.icon });
          return next.slice(-12);
        });
      }
    };

    (async () => {
      while (!stopped) {
        try {
          const res = await fetch(`${API}/v1/conversations/${convId}/stream`, {
            signal: ctrl.signal, credentials: "same-origin",
            headers: { accept: "text/event-stream", "x-tenant-id": TENANT },
          });
          if (!res.ok || !res.body) { await new Promise((r) => setTimeout(r, 1500)); continue; }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const part of parts) {
              const ev = /^event:\s*(.+)$/m.exec(part)?.[1]?.trim();
              const data = /^data:\s*(.+)$/m.exec(part)?.[1];
              if (!ev || !data) continue;
              try { handle(ev, JSON.parse(data)); } catch { /* ignore */ }
            }
          }
        } catch { /* abort або мережа */ }
        if (!stopped) await new Promise((r) => setTimeout(r, 1500));
      }
    })();

    return () => { stopped = true; ctrl.abort(); };
  }, [convId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, thinking, steps, streaming]);

  // цокання таймера, незалежно від стану задачі
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // поки задача виконується — стежимо, чи не просить агент людину
  useEffect(() => {
    if (!busyRun) { setHandoff(null); return; }
    const pull = async () => {
      try {
        const d = await api<any>(`/v1/runs/${busyRun}`);
        if (d?.handoff) setHandoff({ id: d.handoff.id, question: d.handoff.question, options: d.handoff.options ?? [] });
        // кроки з задач (працює й без SSE — через тунель події не доходять)
        if (!sseAlive.current && Array.isArray(d?.tasks)) {
          setSteps(d.tasks.map((t: any) => ({
            label: String(t.goal).slice(0, 70),
            status: t.status === "done" ? "done" : t.status === "failed" ? "failed" : t.status === "running" ? "running" : "running",
            icon: t.status === "done" ? "✓" : t.status === "failed" ? "✕" : "⏳",
          })));
        }
      } catch { /* ignore */ }
    };
    pull();
    const t = setInterval(pull, 2500);
    return () => clearInterval(t);
  }, [busyRun]);

  async function startConfirmed(text: string) {
    if (!convId) return;
    try {
      const r = await api<{ runId: string }>(`/v1/conversations/${convId}/start`, { method: "POST", body: JSON.stringify({ text }) });
      setBusyRun(r.runId); setRunStart(Date.now());
      setSteps([{ label: "Починаю пошук…", status: "running", icon: "⏳" }]);
    } catch (e: any) { setError(e.message); }
  }

  async function answerHandoff(option?: string) {
    if (!handoff) return;
    try {
      await api(`/v1/handoffs/${handoff.id}/resolve`, { method: "POST",
        body: JSON.stringify(option ? { option } : { answer: manual.trim() || "продовжити" }) });
      setHandoff(null); setManual("");
      setSteps((prev) => [...prev, { label: option ? "Продовжую після вашого рішення" : "Взяв ваші дані", status: "running", icon: "⏳" }]);
    } catch (e: any) { setError(e.message); }
  }

  async function toggleMic() {
    if (listening) { recRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/mp4";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      // ── живий рівень + таймер (одразу видно, що мікрофон чує) ──
      const actx = new AudioContext();
      await actx.resume().catch(() => {});
      const analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      actx.createMediaStreamSource(stream).connect(analyser);
      const frame = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      let lastVoice = Date.now();
      let spokeAt = 0;
      const tick = setInterval(() => {
        analyser.getByteTimeDomainData(frame);
        let sum = 0;
        for (let i = 0; i < frame.length; i++) { const v = (frame[i]! - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / frame.length);
        micLevelRef.current = rms;
        setMicLevel(Math.min(1, rms * 6));
        setMicSeconds(Math.floor((Date.now() - startedAt) / 1000));
        if (rms > 0.008) { lastVoice = Date.now(); if (!spokeAt) spokeAt = Date.now(); }
        else if (spokeAt && Date.now() - lastVoice > 2500) { rec.stop(); }   // авто-стоп після 2.5 с тиші
      }, 80);

      // ── живий частковий текст: браузерне розпізнавання як ПРЕВ'Ю (фінал — Whisper) ──
      let recog: any = null;
      try {
        const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SR) {
          recog = new SR();
          recog.lang = "uk-UA"; recog.interimResults = true; recog.continuous = true;
          let acc = "";
          recog.onresult = (e: any) => {
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const r = e.results[i];
              if (r.isFinal) acc += r[0].transcript + " ";
              else interim += r[0].transcript;
            }
            setPreview((acc + interim).trim().slice(0, 300));
          };
          recog.onerror = () => {};
          recog.start();
        }
      } catch { /* прев'ю недоступне — покажемо рівень і таймер */ }

      rec.onstop = async () => {
        clearInterval(tick); actx.close().catch(() => {});
        try { recog?.stop(); } catch {}
        stream.getTracks().forEach((t) => t.stop());
        setListening(false); setMicLevel(0); setMicSeconds(0);

        const previewText = preview.trim();
        const bytes = chunks.reduce((n, c: any) => n + (c.size ?? 0), 0);
        // порожній або надто короткий запис — не турбуємо сервер
        if (bytes < 2000) {
          setPreview("");
          if (previewText) setText((prev) => fixTranscript((prev ? prev + " " : "") + previewText));
          else setError("Запис порожній — натисніть 🎤 і говоріть ближче до мікрофона.");
          return;
        }
        setTranscribing(true);
        try {
          const blob = new Blob(chunks, { type: mime.split(";")[0] });
          const res = await fetch(`${API}/v1/voice/transcribe`, {
            method: "POST", credentials: "same-origin",
            headers: { "content-type": blob.type, "x-tenant-id": TENANT },
            body: blob,
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? `HTTP ${res.status}`);
          const data = await res.json();
          const finalText = (data.text || "").trim() || previewText;
          if (finalText) setText((prev) => fixTranscript((prev ? prev + " " : "") + finalText));
          else setError("Не вдалося розпізнати мовлення. Говоріть ближче до мікрофона і трохи повільніше.");
        } catch (e: any) {
          if (previewText) setText((prev) => fixTranscript((prev ? prev + " " : "") + previewText));
          else setError("Розпізнавання не вдалося: " + e.message);
        } finally { setPreview(""); setTranscribing(false); }
      };

      recRef.current = rec; rec.start(); setListening(true); setError(null); setPreview("");
      setTimeout(() => { if (rec.state === "recording") rec.stop(); }, 60_000);
    } catch (e: any) {
      setListening(false);
      const insecure = typeof window !== "undefined" && !window.isSecureContext;
      setError(insecure
        ? "Мікрофон потребує HTTPS. Відкрийте сайт за адресою https://… (тунель), а не http:// — Safari блокує запис на незахищених сторінках."
        : "Немає доступу до мікрофона: " + (e?.message ?? "невідома помилка"));
    }
  }

  async function stopRun() {
    if (!busyRun || stopping) return;
    setStopping(true);
    try {
      await api(`/v1/runs/${busyRun}/cancel`, { method: "POST", body: JSON.stringify({ mode: "soft" }) });
      setSteps((prev) => [...prev, { label: "Зупинено вами", status: "failed", icon: "■" }]);
      setBusyRun(null); setRunStart(null);
    } catch (e: any) { setError(e.message); }
    finally { setStopping(false); }
  }

  async function send(override?: string) {
    const value = (override ?? text).trim();
    if (!value || thinking) return;
    let cid = convId;
    if (!cid) cid = await newConv();
    setText(""); setError(null); setThinking(true); setStreaming(null);
    setSteps([{ label: "Думаю над планом…", status: "running", icon: "⏳" }]);
    setRunStart(Date.now());
    const tempUser: Msg = { id: `tmp-${Date.now()}`, role: "user", content: value, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, tempUser]);
    try {
      const r = await api<{ messageId: string; content: string; runId: string | null; intent: string; plan?: string[]; options?: string[] }>(
        `/v1/conversations/${cid}/messages`, { method: "POST", body: JSON.stringify({ text: value }) });
      setMsgs((m) => (m.some((x) => x.id === r.messageId) ? m
        : [...m, { id: r.messageId, role: "assistant", content: r.content, meta: { intent: r.intent, plan: r.plan, options: r.options, pending: (r as any).pending }, run_id: r.runId, created_at: new Date().toISOString() }]));
      setThinking(false); setStreaming(null);
      if (r.runId) setBusyRun(r.runId);   // кроки НЕ чистимо: перші вже могли прийти через SSE
      loadConvs();
      // watchdog: SSE через проксі/тунель може не доходити — тоді опитуємо
      clearTimeout(pollTimer.current);
      pollTimer.current = setTimeout(async () => {
        if (sseAlive.current || !cid) return;
        for (let i = 0; i < 80; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const d = await api<{ messages: Msg[] }>(`/v1/conversations/${cid}`);
            setMsgs((prev) => {
              const known = new Set(prev.map((m) => m.id));
              const fresh = d.messages.filter((m) => !known.has(m.id));
              return fresh.length ? [...prev, ...fresh] : prev;
            });
            if (d.messages.some((m) => m.role === "assistant" && m.meta?.intent === "result")) { setBusyRun(null); setRunStart(null); break; }
          } catch { /* ignore */ }
        }
      }, 3500);
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
              {busyRun ? `${steps.find((x) => x.status === "running")?.label ?? "працюю…"}` : "ваш цифровий помічник"}
            </div>
          </div>
          {busyRun ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "#8b93a7", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                ⏱ {String(Math.floor(runSeconds / 60)).padStart(2, "0")}:{String(runSeconds % 60).padStart(2, "0")}
              </span>
              <button onClick={stopRun} disabled={stopping} aria-label="Зупинити"
                style={{ background: "#3a1418", border: "1px solid #7a2730", color: "#ff9b9b", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }}>
                ■ {stopping ? "…" : "Стоп"}
              </button>
            </div>
          ) : (
            <button onClick={newConv} aria-label="Нова розмова"
              style={{ background: "#4f7cff", border: 0, color: "#fff", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }}>+ Нова</button>
          )}
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
                <div style={{ fontSize: 15, marginTop: 10 }}>
                  Привіт! Я ваш цифровий помічник.{proactive.length > 0 ? " Пам'ятаю, що ми робили раніше — можу продовжити." : ""}
                </div>
                <div style={{ fontSize: 12.5, color: "#8b93a7", marginTop: 6, maxWidth: 460, marginInline: "auto", lineHeight: 1.6 }}>
                  Можу перевірити сайти, розпізнати чеки й накладні, зробити таблицю чи звіт і запам'ятати контекст.
                </div>
                {proactive.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <div style={{ fontSize: 11, color: "#5f677a", marginBottom: 8, textTransform: "uppercase", letterSpacing: .4 }}>На основі вашої історії</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                      {proactive.map((sug) => (
                        <button key={sug.label} onClick={() => send(sug.text)} style={{
                          fontSize: 12.5, padding: "8px 13px", borderRadius: 99, border: "1px solid #2a4aa8",
                          background: "#14204a", color: "#b9c9ff", cursor: "pointer" }}>{sug.label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginTop: 16 }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} style={{ fontSize: 12, padding: "7px 12px", borderRadius: 99, border: "1px solid #232838", background: "#12151d", color: "#c7ccd8", cursor: "pointer" }}>{s}</button>
                  ))}
                </div>
              </div>
            )}

            {msgs.map((m) => <Bubble key={m.id} msg={m} onPick={send} onConfirm={startConfirmed} onEdit={(t) => { setText(t); }} />)}

            {thinking && <Typing />}
            {streaming && streaming.text.length > 0 && (
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
                  <div key={`${s.label}-${i}`} className="step-row" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: s.status === "failed" ? "#ff9b9b" : s.status === "running" ? "#8b93a7" : "#7fc9a6" }}>
                    <span style={{ width: 14, textAlign: "center", flexShrink: 0 }}>{s.icon ?? (s.status === "running" ? "⏳" : "✓")}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                  </div>
                ))}
              </div>
            )}
            {busyRun && !thinking && !streaming && (
              <div style={{ margin: "6px 0 0 38px", display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "#5f677a" }}>
                <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 99, background: "#3ecf8e", animation: "pulse 1.2s infinite" }} />
                працюю · ⏱ {String(Math.floor(runSeconds / 60)).padStart(2, "0")}:{String(runSeconds % 60).padStart(2, "0")}
                <style>{`@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}`}</style>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {listening && (
            <div style={{ margin: "0 0 8px", padding: "10px 12px", borderRadius: 10, background: "#121a2b", border: "1px solid #2a3a58" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: "#ff5a5a", boxShadow: "0 0 8px #ff5a5a", flexShrink: 0 }} />
                <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 24, flex: 1, minWidth: 0 }}>
                  {Array.from({ length: 28 }).map((_, i) => {
                    const phase = Math.sin((Date.now() / 140) + i * 0.6);
                    const h = Math.max(3, Math.min(24, (micLevel * 26) + Math.abs(phase) * micLevel * 14 + 3));
                    return <span key={i} style={{ flex: 1, height: h, borderRadius: 2,
                      background: micLevel > 0.05 ? "#4f7cff" : "#2a3a58", transition: "height 80ms linear" }} />;
                  })}
                </div>
                <span style={{ fontSize: 12.5, color: "#9fb3d9", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {String(Math.floor(micSeconds / 60)).padStart(2, "0")}:{String(micSeconds % 60).padStart(2, "0")}
                </span>
                <button onClick={() => recRef.current?.stop()} aria-label="Зупинити запис"
                  style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 8, border: 0, background: "#ff5a5a", color: "#fff", fontSize: 12.5, cursor: "pointer" }}>
                  ■ Стоп
                </button>
              </div>
              <div style={{ marginTop: 8, fontSize: 13, color: micLevel > 0.05 ? "#dfe6f5" : "#6b7896", minHeight: 18, lineHeight: 1.4 }}>
                {preview || (micLevel > 0.05 ? "слухаю…" : "говоріть — я записую")}
              </div>
            </div>
          )}

          {handoff && (
            <div style={{ margin: "6px 0", padding: "12px 14px", borderRadius: 10, background: "#241b0a", border: "1px solid #5a4318" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Потрібна ваша участь</div>
              <div style={{ fontSize: 12.5, color: "#e8d5a8", lineHeight: 1.6 }}>
                {handoff.question.split(/(https?:\/\/\S+)/g).map((part, i) =>
                  /^https?:\/\//.test(part)
                    ? <a key={i} href={part} target="_blank" rel="noopener" style={{ color: "#7fb0ff", textDecoration: "underline" }}>{part}</a>
                    : <span key={i}>{part}</span>)}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                <button onClick={() => answerHandoff("done")} style={{ padding: "8px 14px", borderRadius: 8, border: 0, background: "#4f7cff", color: "#fff", fontSize: 13, cursor: "pointer" }}>Продовжити</button>
                <button onClick={() => answerHandoff("skip")} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #2a3145", background: "transparent", color: "#c7ccd8", fontSize: 13, cursor: "pointer" }}>Пропустити сайт</button>
                <button onClick={() => answerHandoff("abort")} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #7a2730", background: "transparent", color: "#ff9b9b", fontSize: 13, cursor: "pointer" }}>Зупинити</button>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="або вставте дані (напр. ціну) вручну"
                  style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid #3a2f18", background: "#0e1117", color: "#e6e8ee", fontSize: 13 }} />
                <button onClick={() => answerHandoff()} disabled={!manual.trim()}
                  style={{ padding: "8px 12px", borderRadius: 8, border: 0, background: manual.trim() ? "#3ecf8e" : "#2a3145", color: "#06120c", fontSize: 13, cursor: manual.trim() ? "pointer" : "default" }}>Взяти</button>
              </div>
            </div>
          )}

          {error && <div style={{ margin: "6px 0", padding: "9px 12px", borderRadius: 8, background: "#2a1518", border: "1px solid #5a2530", color: "#ff9b9b", fontSize: 12 }}>{error}</div>}

          <div className="chat-composer">
            <div className="composer-box">
              <textarea className="composer-input" rows={1} value={text} placeholder="Напишіть повідомлення…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button onClick={toggleMic} aria-label="Диктувати" title="Диктувати"
                style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 8, border: `1px solid ${listening ? "#ff6b6b" : "#2a3145"}`,
                  background: listening ? "#3a1418" : "transparent", color: listening ? "#ff9b9b" : "#8b93a7", fontSize: 16, cursor: "pointer" }}>
                {listening ? "■" : "🎤"}
              </button>
              <button className="composer-send" onClick={() => send()} disabled={thinking || transcribing || !text.trim()}
                style={{ background: thinking || !text.trim() ? "#2a3145" : "#4f7cff", color: "#fff", cursor: thinking ? "default" : "pointer" }}>
                {thinking || transcribing ? "…" : "Надіслати"}
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

function Bubble({ msg, onPick, onConfirm, onEdit }: { msg: Msg; onPick: (v: string) => void; onConfirm?: (t: string) => void; onEdit?: (t: string) => void }) {
  const mine = msg.role === "user";
  const options: string[] = [];   // clarify прибрано: агент не питає дозволу
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

        {(msg.meta?.intent === "confirm") && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            <button onClick={() => onConfirm?.(msg.meta?.pending?.text ?? "")}
              style={{ padding: "8px 14px", borderRadius: 8, border: 0, background: "#3ecf8e", color: "#06120c", fontSize: 13, cursor: "pointer" }}>
              Почати пошук
            </button>
            <button onClick={() => onEdit?.(msg.meta?.pending?.text ?? "")}
              style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #2a3145", background: "transparent", color: "#c7ccd8", fontSize: 13, cursor: "pointer" }}>
              Виправити
            </button>
          </div>
        )}
        {!mine && (
          <button onClick={() => speak(msg)} title="Озвучити" aria-label="Озвучити"
            style={{ marginTop: 4, background: "transparent", border: 0, color: "#4d5568", fontSize: 12, cursor: "pointer", padding: "2px 4px" }}>
            🔊
          </button>
        )}
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
