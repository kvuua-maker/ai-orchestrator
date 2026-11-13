"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV = [
  { href: "/", label: "Задача" },
  { href: "/runs", label: "Запуски" },
  { href: "/dashboard", label: "Метрики" },
  { href: "/billing", label: "Тариф" },
  { href: "/settings", label: "Підключення" },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-inner">
          <Link href="/" className="brand">AI Orchestrator</Link>
          <nav className="shell-nav">
            {NAV.map((n) => {
              const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} className="nav-link" style={{
                  color: active ? "#e6e8ee" : "#8b93a7", background: active ? "#181d29" : "transparent",
                }}>{n.label}</Link>
              );
            })}
          </nav>
          <Link href="/onboarding" style={{ fontSize: 12, color: "#8b93a7", textDecoration: "none", whiteSpace: "nowrap" }}>Онбординг</Link>
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </div>
  );
}

export function Card({ title, children, hint }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ padding: 18, borderRadius: 12, background: "#12151d", border: "1px solid #232838" }}>
      {title && <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>{title}</h2>
        {hint && <span style={{ fontSize: 11, color: "#5f677a" }}>{hint}</span>}
      </div>}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div style={{ padding: 16, borderRadius: 10, background: "#12151d", border: "1px solid #232838" }}>
      <div style={{ fontSize: 11, color: "#8b93a7", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 620, marginTop: 6 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: "#5f677a", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontSize: 11, padding: "3px 9px", borderRadius: 999, color, background: `${color}1a`, border: `1px solid ${color}44`, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

export function Progress({ value, max, danger }: { value: number; max: number; danger?: boolean }) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 100);
  const color = danger || pct >= 90 ? "#ff6b6b" : pct >= 70 ? "#ffb020" : "#3ecf8e";
  return (
    <div style={{ height: 7, borderRadius: 99, background: "#1c2130", overflow: "hidden", marginTop: 8 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width .3s" }} />
    </div>
  );
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 16px", border: "1px dashed #232838", borderRadius: 12 }}>
      <div style={{ fontSize: 28, opacity: 0.35 }}>◍</div>
      <div style={{ fontSize: 14, marginTop: 8 }}>{title}</div>
      <div style={{ fontSize: 12, color: "#8b93a7", marginTop: 4, maxWidth: 420, marginInline: "auto" }}>{text}</div>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function ErrorNote({ text }: { text: string }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 8, background: "#2a1518", border: "1px solid #5a2530", color: "#ff9b9b", fontSize: 12 }}>
      {text}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div style={{ display: "grid", gap: 8 }}>
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} style={{ height: 38, borderRadius: 8, background: "linear-gradient(90deg,#12151d,#181d29,#12151d)", backgroundSize: "200% 100%", animation: "shimmer 1.2s infinite" }} />
    ))}
    <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
  </div>;
}

export function Button({ children, onClick, variant = "primary", disabled }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "ghost"; disabled?: boolean }) {
  const primary = variant === "primary";
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "9px 16px", borderRadius: 8, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer",
      border: primary ? 0 : "1px solid #2a3145", background: primary ? "#4f7cff" : "transparent",
      color: primary ? "#fff" : "#c7ccd8", opacity: disabled ? 0.55 : 1,
    }}>{children}</button>
  );
}
