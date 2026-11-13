"use client";
import { useEffect, useState } from "react";
import { api } from "../lib";
import { Badge, Button, Card, ErrorNote, Shell, Skeleton } from "../components/ui";

type Item = {
  id: string; name: string; what: string; docs: string; freeTier: string;
  configured: boolean; masked: string | null; source: "settings" | "env" | null; updatedAt: string | null;
};

export default function SettingsPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});

  const load = () => api<{ items: Item[] }>("/v1/integrations").then((d) => setItems(d.items)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function save(id: string) {
    const secret = (drafts[id] ?? "").trim();
    if (!secret) return;
    setBusy(id); setResult((r) => ({ ...r, [id]: "" }));
    try {
      const res = await api<{ saved: boolean; check: { ok: boolean; message: string; ms: number } }>(`/v1/integrations/${id}`, {
        method: "PUT", body: JSON.stringify({ secret }),
      });
      setResult((r) => ({ ...r, [id]: `${res.check.ok ? "✅" : "⚠️"} ${res.check.message} · ${res.check.ms} мс` }));
      setDrafts((d) => ({ ...d, [id]: "" }));
      load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function test(id: string) {
    setBusy(id);
    try {
      const res = await api<{ ok: boolean; message: string; ms: number }>(`/v1/integrations/${id}/test`, { method: "POST", body: "{}" });
      setResult((r) => ({ ...r, [id]: `${res.ok ? "✅" : "⚠️"} ${res.message} · ${res.ms} мс` }));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function remove(id: string) {
    setBusy(id);
    try { await api(`/v1/integrations/${id}`, { method: "DELETE" }); load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  }

  return (
    <Shell>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>Підключення</div>
        <div style={{ fontSize: 13, color: "#8b93a7", marginTop: 4 }}>Зовнішні сервіси, які розширюють можливості агента</div>
      </div>
      {error && <ErrorNote text={error} />}
      {!items && <Skeleton rows={4} />}
      <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
        {items?.map((it) => (
          <Card key={it.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{it.name}</span>
                  <Badge color={it.configured ? "#3ecf8e" : "#8b93a7"} label={it.configured ? "підключено" : "не підключено"} />
                  {it.masked && <span style={{ fontSize: 12, color: "#8b93a7" }}>{it.masked}</span>}
                  {it.source === "env" && <span style={{ fontSize: 11, color: "#5f677a" }}>з .env</span>}
                </div>
                <div style={{ fontSize: 13, color: "#aab2c5", marginTop: 4, lineHeight: 1.5 }}>{it.what}</div>
                <div style={{ fontSize: 11.5, color: "#5f677a", marginTop: 4 }}>
                  {it.freeTier} · <a href={it.docs} target="_blank" rel="noreferrer" style={{ color: "#7aa2ff" }}>отримати ключ</a>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <input
                value={drafts[it.id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [it.id]: e.target.value }))}
                placeholder={it.configured ? "вставте новий ключ, щоб замінити" : "вставте ключ"}
                style={{ flex: 1, minWidth: 200, padding: "9px 11px", borderRadius: 8, border: "1px solid #2a3145", background: "#0e1117", color: "#e6e8ee", fontSize: 13 }}
              />
              <Button onClick={() => save(it.id)} disabled={busy === it.id || !(drafts[it.id] ?? "").trim()}>
                {busy === it.id ? "перевіряю…" : "Зберегти й перевірити"}
              </Button>
              {it.configured && (
                <>
                  <Button variant="ghost" onClick={() => test(it.id)} disabled={busy === it.id}>Перевірити</Button>
                  <Button variant="ghost" onClick={() => remove(it.id)} disabled={busy === it.id}>Відключити</Button>
                </>
              )}
            </div>
            {result[it.id] && <div style={{ marginTop: 8, fontSize: 12.5, color: "#9fd6b0" }}>{result[it.id]}</div>}
          </Card>
        ))}
      </div>

      <div style={{ marginTop: 18, fontSize: 12, color: "#5f677a", lineHeight: 1.6 }}>
        Ключі зберігаються на сервері у зашифрованому вигляді (AES-256-GCM) і ніколи не повертаються в інтерфейс —
        ви бачите лише маску. Підключені сервіси одразу стають доступні інструментам агента.
      </div>
    </Shell>
  );
}
