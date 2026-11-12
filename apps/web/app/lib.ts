export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const TENANT = process.env.NEXT_PUBLIC_TENANT ?? "tnt_demo0001";

export const H = { "content-type": "application/json", "x-tenant-id": TENANT };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`, body?.error?.code);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); this.name = "ApiError"; }
}

export const STATUS_LABEL: Record<string, [string, string]> = {
  queued: ["У черзі", "#8b93a7"],
  planning: ["Планування", "#5b9dff"],
  running: ["Виконується", "#5b9dff"],
  blocked: ["Потрібна людина", "#ffb020"],
  stalled: ["Завис", "#ff8a3d"],
  done: ["Готово", "#3ecf8e"],
  failed: ["Помилка", "#ff6b6b"],
  cancelled: ["Скасовано", "#8b93a7"],
};

export const fmtUsd = (n: number) => `$${n.toFixed(4)}`;
export const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
