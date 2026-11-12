"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell, Card, Button, Badge } from "../components/ui";

type Step = { id: string; title: string; text: string; href?: string; action?: string };

const STEPS: Step[] = [
  { id: "account", title: "Акаунт готовий", text: "Тенант створено автоматично. Дані ізольовані на рівні бази (RLS) — сусіди вас не бачать." },
  { id: "first-run", title: "Перша задача", text: "Опишіть задачу звичайною мовою. Агент складе план, виконає кроки й покаже результат.", href: "/", action: "Створити задачу" },
  { id: "docs", title: "Документи", text: "Завантажте чек або накладну — агент розпізнає суму, дату, ЄДРПОУ та перевірить арифметику.", href: "/", action: "Завантажити файл" },
  { id: "billing", title: "Тариф", text: "Старт безкоштовний: 100 запусків на місяць. Підвищити можна будь-коли.", href: "/billing", action: "Подивитись тариф" },
];

const KEY = "aio.onboarding.done";

export default function Onboarding() {
  const [done, setDone] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try { setDone(JSON.parse(localStorage.getItem(KEY) ?? "[]")); } catch { setDone([]); }
    setReady(true);
  }, []);

  function toggle(id: string) {
    const next = done.includes(id) ? done.filter((x) => x !== id) : [...done, id];
    setDone(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  }

  const pct = Math.round((done.length / STEPS.length) * 100);

  return (
    <Shell>
      <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>Онбординг</h1>
      <p style={{ fontSize: 13, color: "#8b93a7", marginTop: 0 }}>Чотири кроки, щоб отримати перший результат. {pct}% готово.</p>

      <div style={{ height: 6, borderRadius: 99, background: "#1c2130", margin: "14px 0 22px", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "#3ecf8e", transition: "width .3s" }} />
      </div>

      {!ready ? null : (
        <div style={{ display: "grid", gap: 10 }}>
          {STEPS.map((s, i) => {
            const isDone = done.includes(s.id);
            return (
              <Card key={s.id}>
                <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <button onClick={() => toggle(s.id)} aria-label={isDone ? "Позначити незавершеним" : "Позначити виконаним"}
                    style={{
                      width: 26, height: 26, borderRadius: 99, flexShrink: 0, cursor: "pointer",
                      border: `1px solid ${isDone ? "#3ecf8e" : "#2a3145"}`,
                      background: isDone ? "#3ecf8e" : "transparent", color: isDone ? "#06120c" : "#5f677a", fontSize: 14,
                    }}>{isDone ? "✓" : i + 1}</button>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <b style={{ fontSize: 14 }}>{s.title}</b>
                      {isDone && <Badge label="готово" color="#3ecf8e" />}
                    </div>
                    <p style={{ fontSize: 12, color: "#8b93a7", margin: "5px 0 0", lineHeight: 1.6 }}>{s.text}</p>
                    {s.href && <div style={{ marginTop: 10 }}><Link href={s.href} style={{ color: "#4f7cff", fontSize: 12, textDecoration: "none" }}>{s.action} →</Link></div>}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {done.length === STEPS.length && (
        <div style={{ marginTop: 18, padding: 16, borderRadius: 10, background: "#0f231a", border: "1px solid #1f5138", fontSize: 13 }}>
          Усе готово. Далі — просто описуйте задачі; агент сам вирішує, коли потрібна ваша участь.
          <div style={{ marginTop: 12 }}><Link href="/"><Button>До задач</Button></Link></div>
        </div>
      )}
    </Shell>
  );
}
