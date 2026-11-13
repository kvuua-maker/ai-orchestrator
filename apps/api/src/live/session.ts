import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import type { Browser, Page } from "playwright";

/**
 * «Живий браузер»: справжній Chromium на віртуальному екрані, до якого користувач
 * підключається через noVNC і сам проходить перевірку. Агент потім працює в ТІЙ САМІЙ
 * сесії (ті самі cookies), тому після ручного рішення сторінка вже доступна.
 */

const PROFILE = "/mnt/HC_Volume_106461592/aio/live/profile";
const CDP = "http://127.0.0.1:9222";
const VNC_FILE = "/mnt/HC_Volume_106461592/aio/live/vnc.url";
const PASS_FILE = "/mnt/HC_Volume_106461592/aio/live/vnc.env";

let launching: Promise<void> | null = null;
let browser: Browser | null = null;

export function vncInfo(): { url: string | null; password: string | null } {
  try {
    const url = readFileSync(VNC_FILE, "utf8").trim();
    const raw = readFileSync(PASS_FILE, "utf8").trim();
    const password = raw.includes("=") ? raw.split("=")[1]!.trim() : raw;
    return { url: url || null, password: password || null };
  } catch { return { url: null, password: null }; }
}

async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch { return false; }
}

/** Піднімає видимий Chromium (якщо ще не запущений) і відкриває URL. */
export async function ensureLiveBrowser(url?: string): Promise<{ ok: boolean; alreadyRunning: boolean }> {
  if (await cdpAlive()) {
    if (url) await openInLive(url).catch(() => {});
    return { ok: true, alreadyRunning: true };
  }
  if (launching) { await launching; if (url) await openInLive(url).catch(() => {}); return { ok: true, alreadyRunning: false }; }

  launching = (async () => {
    // окремий systemd-сервіс: переживає перезапуск API
    await new Promise<void>((resolve) => {
      const { execFile } = require("node:child_process");
      execFile("systemctl", ["start", "aio-live-browser"], () => resolve());
    });
    for (let i = 0; i < 40; i++) {
      if (await cdpAlive()) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  })().finally(() => { launching = null; });

  await launching;
  return { ok: true, alreadyRunning: false };
}

async function liveContext(): Promise<{ ctx: any; page: Page } | null> {
  const { chromium } = await import("playwright");
  const b = await chromium.connectOverCDP(CDP);
  const ctx = b.contexts()[0];
  if (!ctx) return null;
  const page = ctx.pages()[0] ?? await ctx.newPage();
  return { ctx, page };
}

export async function openInLive(url: string): Promise<void> {
  const live = await liveContext();
  if (!live) return;
  await live.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
}

/** Сторінка з живої сесії: після ручного проходження перевірки cookies уже є. */
export async function fetchViaLive(url: string, waitMs = 2500): Promise<{ status: number; title: string; text: string; prices: string[] } | null> {
  if (!(await cdpAlive())) return null;
  const live = await liveContext();
  if (!live) return null;
  const { page } = live;
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
  const title = await page.title();
  const text = ((await page.locator("body").innerText().catch(() => "")) ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const prices = [...text.matchAll(/(\d[\d\s]{2,9}(?:[.,]\d{2})?)\s*(?:₴|грн)/g)].map((m) => `${m[1]!.replace(/\s/g, "")} грн`).slice(0, 20);
  return { status: resp?.status() ?? 0, title, text: text.slice(0, 12_000), prices };
}

export async function liveStatus(): Promise<{ running: boolean; url: string | null; vnc: string | null }> {
  const running = await cdpAlive();
  let url: string | null = null;
  if (running) {
    try {
      const live = await liveContext();
      url = live?.page.url() ?? null;
    } catch { /* ignore */ }
  }
  return { running, url, vnc: vncInfo().url };
}
