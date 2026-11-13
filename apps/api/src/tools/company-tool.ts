import { z } from "zod";
import { defineTool } from "./sdk.js";

/**
 * company.lookup — дані про українські компанії.
 * Джерела за пріоритетом: Opendatabot API (якщо є ключ) → UA-REGION (безкоштовно, працює без ключа).
 * Ніяких CAPTCHA-зупинок: якщо джерело не дало даних, пробуємо наступне.
 */

interface Company {
  name: string; edrpou: string | null; address: string | null;
  director: string | null; activity: string | null; status: string | null;
  registeredAt: string | null; source: string; url: string;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function field(text: string, label: RegExp): string | null {
  const m = text.match(label);
  if (!m) return null;
  const line = text.slice(m.index! + m[0].length).split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return line ? clean(line).slice(0, 200) : null;
}

async function viaOpendatabot(query: string): Promise<Company | null> {
  const key = process.env.OPENDATABOT_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.opendatabot.com/api/v3/company/search?q=${encodeURIComponent(query)}&apiKey=${key}`,
      { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const item = json?.data?.[0];
    if (!item) return null;
    return {
      name: item.name ?? query, edrpou: item.edrpou ?? null,
      address: item.address ?? null, director: item.director ?? null,
      activity: item.activity_kved_name ?? null, status: item.status ?? null,
      registeredAt: item.registration_date ?? null, source: "Opendatabot API", url: `https://opendatabot.com/c/${item.edrpou}`,
    };
  } catch { return null; }
}

async function viaUaRegion(query: string): Promise<Company | null> {
  const { getBrowser } = await import("./browser-tool.js");
  const browser: any = await getBrowser();
  const ctx = await browser.newContext({
    locale: "uk-UA", viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    extraHTTPHeaders: { "accept-language": "uk-UA,uk;q=0.9" },
  });
  const watchdog = setTimeout(() => { ctx.close().catch(() => {}); }, 25_000);
  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.ua-region.com.ua/search?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 12_000 });
    await page.waitForTimeout(2500);

    // беремо перший результат, у назві якого є слова запиту
    const tokens = query.toLowerCase().replace(/тов|тзов|пат|фоп/gi, " ").split(/[^a-zа-яіїєґ0-9]+/i).filter((w) => w.length >= 3);
    const links: Array<{ text: string; href: string }> = await page.evaluate(() =>
      [...document.querySelectorAll("a[href*='/']")].map((a: any) => ({ text: (a.textContent || "").trim(), href: a.href })));
    const hit = links.find((l) => /ua-region/.test(l.href) && tokens.some((t) => l.text.toLowerCase().includes(t)) && l.text.length > 6);
    if (!hit) return null;

    await page.goto(hit.href, { waitUntil: "domcontentloaded", timeout: 12_000 });
    await page.waitForTimeout(1800);
    const text = await page.locator("body").innerText().catch(() => "");
    const edrpou = text.match(/ЄДРПОУ\s*(\d{8,10})/)?.[1] ?? null;

    return {
      name: clean(hit.text.replace(/^Опис\s*/i, "")) || query,
      edrpou,
      address: field(text, /Юридична адреса/),
      director: field(text, /Керівник,\s*директор/),
      activity: field(text, /Діяльність\n/),
      status: /внесено до ЄДР|зареєстровано/i.test(text) ? "зареєстровано" : null,
      registeredAt: text.match(/державну реєстрацію від\s*([\d.]+)/)?.[1] ?? null,
      source: "UA-REGION",
      url: page.url(),
    };
  } catch { return null; }
  finally { clearTimeout(watchdog); await ctx.close().catch(() => {}); }
}

export const companyLookup = defineTool({
  name: "company.lookup",
  version: "1.0.0",
  description:
    "Look up a Ukrainian company by name or ЄДРПОУ: returns official name, registration code, legal address, " +
    "director, activity and registration date. Use this for any question about a Ukrainian legal entity.",
  input: z.object({ query: z.string().min(2) }),
  output: z.object({
    found: z.boolean(),
    company: z.object({
      name: z.string(), edrpou: z.string().nullable(), address: z.string().nullable(),
      director: z.string().nullable(), activity: z.string().nullable(), status: z.string().nullable(),
      registeredAt: z.string().nullable(), source: z.string(), url: z.string(),
    }).nullable(),
    tried: z.array(z.string()),
  }),
  risk: "read", effectClass: "pure", costClass: "cheap",
  scopes: ["browser:read"], agents: ["browser", "data", "synthesizer", "verifier"],
  timeoutMs: 32_000, maxRetries: 0,
  async execute({ query }) {
    const tried: string[] = [];
    // 1) локальний офіційний ЄДР — мілісекунди
    try {
      const { edrFind } = await import("./edr-tool.js");
      const rows = await edrFind(query, 3);
      tried.push("ЄДР (локальний)");
      if (rows.length) {
        const r = rows[0]!;
        return { data: { found: true, tried, company: {
          name: r.name, edrpou: r.edrpou, address: null, director: r.director,
          activity: r.opf, status: r.status, registeredAt: r.registered_at,
          source: "ЄДР (офіційний реєстр, локальна копія)", url: `https://opendatabot.ua/c/${r.edrpou}`,
        } } };
      }
    } catch { /* ignore */ }

    for (const [name, fn] of [["Opendatabot API", viaOpendatabot], ["UA-REGION", viaUaRegion]] as const) {
      const res = await (fn as any)(query).catch(() => null);
      tried.push(name);
      if (res?.edrpou || res?.name) return { data: { found: true, company: res, tried } };
    }
    return { data: { found: false, company: null, tried } };
  },
  async simulate({ query }) { return { data: { found: false, company: null, tried: ["simulate"] } }; },
});
