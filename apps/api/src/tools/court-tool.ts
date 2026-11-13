import { z } from "zod";
import { defineTool } from "./sdk.js";

/**
 * court.search — пошук у Єдиному державному реєстрі судових рішень (reyestr.court.gov.ua).
 * Сайт — JSF-форма, тому працюємо справжнім браузером. Повертає справи з посиланнями.
 */

interface CourtHit {
  id: string; url: string; type: string; date: string;
  caseNumber: string; court: string; judge: string; raw: string;
}

export const courtSearch = defineTool({
  name: "court.search",
  version: "1.0.0",
  description:
    "Search the Unified State Register of Court Decisions of Ukraine (reyestr.court.gov.ua) by any phrase: " +
    "a person's full name, a company name, a tax code or a case number. Returns decisions with case numbers, " +
    "courts, judges, dates and direct links.",
  input: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  output: z.object({
    query: z.string(),
    total: z.string(),
    hits: z.array(z.object({
      id: z.string(), url: z.string(), type: z.string(), date: z.string(),
      caseNumber: z.string(), court: z.string(), judge: z.string(),
    })),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["browser:read"], agents: ["synthesizer", "data", "verifier", "browser"],
  timeoutMs: 30_000, maxRetries: 0,
  async execute({ query, limit }) {
    const { getBrowser } = await import("./browser-tool.js");
    const browser: any = await getBrowser();
    const ctx = await browser.newContext({
      locale: "uk-UA", viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const watchdog = setTimeout(() => { ctx.close().catch(() => {}); }, 27_000);
    try {
      const page = await ctx.newPage();
      await page.goto("https://reyestr.court.gov.ua/", { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(1200);
      await page.fill("input[name='SearchExpression']", query.slice(0, 200));
      await page.press("input[name='SearchExpression']", "Enter");
      await page.waitForTimeout(5500);

      const total = await page.evaluate(() => {
        const m = (document.body.innerText || "").match(/знайдено документів:\s*(\d+)/i);
        return m ? m[1]! : "0";
      });

      const rows: CourtHit[] = await page.evaluate(() => {
        const out: any[] = [];
        document.querySelectorAll("tr").forEach((tr) => {
          const a = tr.querySelector("a[href*='Review']") as HTMLAnchorElement | null;
          if (!a) return;
          const text = (tr as HTMLElement).innerText.replace(/\s+/g, " ").trim();
          if (!text) return;
          const id = (a.href.match(/Review\/(\d+)/) || [])[1] || "";
          const dates = text.match(/\d{2}\.\d{2}\.\d{4}/g) || [];
          const caseNum = (text.match(/\b\d{1,4}\/\d{1,6}\/\d{2,4}\b/) || [])[0] || "";
          const type = (text.match(/(Ухвала|Рішення|Постанова|Вирок|Судовий наказ)/) || [])[0] || "";
          const court = ((text.match(/([А-ЯІЇЄҐ][^0-9]{6,90}?суд[уа]?[^0-9]{0,45})/) || [])[1] || "").replace(/\s*[А-ЯІЇЄҐ][а-яіїєґ'’\-]+ [А-ЯІЇЄҐ]\. ?[А-ЯІЇЄҐ]\.\s*$/, "").trim();
          const judge = (text.match(/([А-ЯІЇЄҐ][а-яіїєґ'’\-]+ [А-ЯІЇЄҐ]\. ?[А-ЯІЇЄҐ]\.)\s*$/) || [])[1] || "";
          out.push({ id, url: a.href, type, date: dates[0] || "", caseNumber: caseNum, court: court.trim(), judge, raw: text.slice(0, 200) });
        });
        return out;
      });

      return { data: { query, total, hits: rows.slice(0, limit ?? 10) } };
    } finally {
      clearTimeout(watchdog);
      await ctx.close().catch(() => {});
    }
  },
  async simulate({ query }) { return { data: { query, total: "0", hits: [] as CourtHit[] } }; },
});
