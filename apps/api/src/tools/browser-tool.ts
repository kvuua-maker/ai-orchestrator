import { z } from "zod";
import { defineTool, ToolFailure } from "./sdk.js";

type Browser = { newContext: (o: any) => Promise<any>; close: () => Promise<void>; version: () => string };
let shared: Promise<Browser> | null = null;

/** Один екземпляр Chromium на процес: запуск щоразу коштує ~1 с. */
async function getBrowser(): Promise<Browser> {
  if (!shared) {
    shared = (async () => {
      const { chromium } = await import("playwright");
      const proxy = process.env.BROWSER_PROXY_URL;
      return chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        ...(proxy ? { proxy: { server: proxy } } : {}),
      }) as unknown as Browser;
    })().catch((e) => { shared = null; throw e; });
  }
  return shared!;
}

const CHALLENGE_RE = /(just a moment|трохи зачекайте|перевірка безпеки|триває перевірка|checking your browser|cf-?challenge|challenge-platform|attention required|access denied|unusual traffic|verify you are human|підтвердіть, що ви людина|щоб продовжити, увімкніть javascript)/i;

/**
 * Реальний браузер: рендерить JS, тримає cookies, виконує запити як звичайний користувач.
 * Не обходить CAPTCHA — якщо сайт вимагає перевірку, повертає BLOCKED і людина вирішує.
 */
export const browserOpen = defineTool({
  name: "browser.open",
  version: "1.0.0",
  description:
    "Open a page in a real headless browser (Chromium), wait for JavaScript and return the visible text. " +
    "Use for shops, marketplaces and SPAs where plain HTTP returns empty or blocked content.",
  input: z.object({
    url: z.string().url(),
    waitMs: z.number().int().min(500).max(20000).optional(),
    scroll: z.boolean().optional(),
  }),
  output: z.object({
    status: z.number(),
    url: z.string(),
    title: z.string(),
    text: z.string(),
    blocked: z.boolean(),
    shop: z.boolean(),
    prices: z.array(z.string()),
  }),
  risk: "read", effectClass: "pure", costClass: "cheap",
  scopes: ["browser:read"], agents: ["browser", "data", "verifier", "synthesizer"],
  timeoutMs: 60_000, maxRetries: 0,
  async execute({ url, waitMs, scroll }) {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      locale: "uk-UA", timezoneId: "Europe/Kyiv",
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      extraHTTPHeaders: { "accept-language": "uk-UA,uk;q=0.9,en;q=0.8" },
    });
    const page = await ctx.newPage();
    try {
      let status = 0;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      status = resp?.status() ?? 0;
      await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(waitMs ?? 5000);
      // каталоги підвантажуються скриптом — прокручуємо, щоб дійшли картки з цінами
      const doScroll = scroll !== false;
      if (doScroll) {
        for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1800); await page.waitForTimeout(900); }
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
      const title = await page.title();
      const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
      const text = bodyText.replace(/\n{3,}/g, "\n\n").trim();

      const challengeHit = CHALLENGE_RE.test(title) || CHALLENGE_RE.test(text.slice(0, 1200));
      // заглушка без контенту: мало тексту, нуль цін, сторінка «порожня»
      const emptyShell = text.length < 2500 && !/(₴|грн|кошик|купити|ціна)/i.test(text);
      const blocked = status === 403 || status === 429 || challengeHit || (status >= 200 && status < 300 && emptyShell && /rozetka|comfy|prom|epicentr/i.test(url));
      const prices = [...text.matchAll(/(\d[\d\s]{2,9}(?:[.,]\d{2})?)\s*(?:₴|грн)/g)]
        .map((m) => `${m[1]!.replace(/\s/g, "")} грн`).slice(0, 20);

      if (blocked) {
        throw new ToolFailure("BLOCKED",
          `Сайт показує перевірку безпеки (Cloudflare/anti-bot): ${title || "403"}. ` +
          `Потрібна участь людини — автоматично не обходимо.`, false);
      }

      return {
        data: {
          status, url: page.url(), title,
          text: text.slice(0, 12_000),
          blocked: false,
          shop: /(кошик|купити|ціна|каталог|cart|price|₴)/i.test(text),
          prices,
        },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
  async simulate({ url }) {
    return { data: { simulated: true, url, wouldOpen: true } };
  },
});
