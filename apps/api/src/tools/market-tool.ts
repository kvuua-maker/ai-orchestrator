import { z } from "zod";
import { defineTool } from "./sdk.js";

/**
 * market.prices — сам знаходить ціни на маркетплейсах із вбудованим пошуком.
 * Не залежить від Google/Bing: з цього сервера пошуковики недоступні, а OLX/prom/hotline — так.
 */

interface Source { id: string; name: string; url: (q: string) => string }

const slug = (q: string) => encodeURIComponent(q.trim()).replace(/%20/g, "-");

const SOURCES: Source[] = [
  { id: "olx", name: "OLX", url: (q) => `https://www.olx.ua/uk/list/q-${slug(q).replace(/%2F/g, "-")}/` },
  { id: "prom", name: "Prom.ua", url: (q) => `https://prom.ua/search?search_term=${encodeURIComponent(q)}` },
  { id: "hotline", name: "Hotline", url: (q) => `https://hotline.ua/search/?q=${encodeURIComponent(q)}` },
  { id: "priceua", name: "Price.ua", url: (q) => `https://price.ua/search/?q=${encodeURIComponent(q)}` },
];

const PRICE_RE = /(\d[\d\s\u00a0]{2,9})\s*(₴|грн|UAH)/i;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Витягує пари «назва — ціна» з DOM конкретного маркетплейсу, з загальним фолбеком. */
async function extract(page: any, sourceId: string) {
  return page.evaluate(({ sourceId, priceReSrc }: any) => {
    const PRICE_RE = new RegExp(priceReSrc, "i");
    const out: Array<{ title: string; price: string; url: string }> = [];
    const push = (title: string, price: string, url: string) => {
      const t = (title || "").replace(/\s+/g, " ").trim();
      if (!t || t.length < 4 || t.length > 140) return;
      out.push({ title: t, price: price.replace(/\s/g, ""), url });
    };

    const cards =
      sourceId === "olx" ? [...document.querySelectorAll("[data-cy='l-card']")] :
      sourceId === "prom" ? [...document.querySelectorAll("[data-qaid='product_block'], .js-productad")] :
      [...document.querySelectorAll("article, li, .list-item, .product, .item")].slice(0, 400);

    for (const card of cards as HTMLElement[]) {
      const text = (card.innerText || "").replace(/\s+/g, " ").trim();
      const m = text.match(PRICE_RE);
      if (!m) continue;
      const title = text.split(/\d[\d\s\u00a0]{2,9}\s*(?:₴|грн)/i)[0] || text;
      const link = card.querySelector("a[href^='http'], a[href^='/']") as HTMLAnchorElement | null;
      push(title.slice(0, 140), m[0], link?.href ?? location.href);
    }

    if (!out.length) {
      // загальний фолбек: рядки «назва … 12 345 грн»
      const lines = (document.body?.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length && out.length < 30; i++) {
        const m = lines[i]!.match(PRICE_RE);
        if (!m) continue;
        const title = lines[i]!.replace(PRICE_RE, "").trim() || lines[i - 1] || "";
        push(title.slice(0, 140), m[0], location.href);
      }
    }
    return out;
  }, { sourceId, priceReSrc: PRICE_RE.source });
}

const toNumber = (p: string) => Number(String(p).replace(/[^\d]/g, ""));

const NOISE = /(чохол|скло|плівк|аксесуар|запчастин|ремонт|оренд|bypass|icloud|розблокуван|дамп|плата|корпус|чіп|шлейф|сервіс|обмін|trade)/i;

/** Релевантність: назва має містити модель і обсяг, і не бути аксесуаром/послугою. */
function relevant(title: string, query: string): boolean {
  const t = title.toLowerCase();
  if (NOISE.test(t)) return false;
  const tokens = query.toLowerCase().replace(/gb|гб/g, "").split(/[^a-zа-яіїєґ0-9]+/i).filter((w) => w.length >= 2);
  if (!tokens.length) return true;
  // обсяг пам'яті у запиті має бути в назві (256 ≠ 64)
  const storage = query.match(/(\d{2,4})\s*(gb|гб)/i)?.[1];
  if (storage && !new RegExp(`${storage}\\s*(gb|гб)`, "i").test(t)) return false;
  const hits = tokens.filter((w) => t.includes(w)).length;
  return hits >= Math.min(2, tokens.length);
}

export const marketPrices = defineTool({
  name: "market.prices",
  version: "1.0.0",
  description:
    "Find real prices for a product by searching marketplaces that work without keys (OLX, Prom, Hotline, Price.ua). " +
    "Use this instead of asking the user for links, and as a fallback when a shop blocks direct access.",
  input: z.object({
    query: z.string().min(3),
    minPrice: z.number().int().optional(),
    maxResults: z.number().int().min(1).max(30).optional(),
  }),
  output: z.object({
    query: z.string(),
    items: z.array(z.object({ title: z.string(), price: z.number(), currency: z.string(), source: z.string(), url: z.string() })),
    sources: z.array(z.object({ id: z.string(), ok: z.boolean(), found: z.number() })),
    summary: z.string(),
  }),
  risk: "read", effectClass: "pure", costClass: "cheap",
  scopes: ["browser:read"], agents: ["browser", "data", "synthesizer", "verifier"],
  timeoutMs: 120_000, maxRetries: 0,
  async execute({ query, minPrice, maxResults }) {
    const { getBrowser } = await import("./browser-tool.js");
    const browser: any = await getBrowser();
    const ctx = await browser.newContext({
      locale: "uk-UA", timezoneId: "Europe/Kyiv", viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      extraHTTPHeaders: { "accept-language": "uk-UA,uk;q=0.9" },
    });

    const all: Array<{ title: string; price: number; currency: string; source: string; url: string }> = [];
    const report: Array<{ id: string; ok: boolean; found: number }> = [];

    try {
      const pages = await Promise.all(SOURCES.map(async (src) => {
        const page = await ctx.newPage();
        try {
          const resp = await page.goto(src.url(query), { waitUntil: "domcontentloaded", timeout: 25_000 });
          await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
          await page.waitForTimeout(700);
          if ((resp?.status() ?? 0) >= 400) return { src, rows: [] as any[], ok: false };
          const rows = await extract(page, src.id);
          return { src, rows, ok: true };
        } catch {
          return { src, rows: [] as any[], ok: false };
        } finally {
          await page.close().catch(() => {});
        }
      }));

      for (const { src, rows, ok } of pages) {
        const items = (rows as Array<{ title: string; price: string; url: string }>)
          .map((r) => ({ ...r, n: toNumber(r.price) }))
          .filter((r: { n: number; title: string }) => r.n >= (minPrice ?? 1500) && r.n <= 2_000_000 && relevant(r.title, query))
          .map((r: { title: string; n: number; url: string }) => ({ title: clean(r.title), price: r.n, currency: "UAH", source: src.name, url: r.url }));
        report.push({ id: src.id, ok, found: items.length });
        all.push(...items);
      }
    } finally {
      await ctx.close().catch(() => {});   // браузер спільний — не закриваємо
    }

    // дедуплікація за назвою+ціною, сортування за ціною
    const seen = new Set<string>();
    const uniq = all.filter((i) => { const k = `${i.title}|${i.price}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.price - b.price)
      .slice(0, maxResults ?? 12);

    const summary = uniq.length
      ? `Знайдено ${uniq.length} пропозицій за «${query}»: від ${uniq[0]!.price} до ${uniq[uniq.length - 1]!.price} грн (${[...new Set(uniq.map((i) => i.source))].join(", ")})`
      : `Пропозицій за «${query}» не знайдено`;

    return { data: { query, items: uniq, sources: report, summary } };
  },
  async simulate({ query }) {
    return { data: { query, items: [], sources: [], summary: "simulated" } };
  },
});
