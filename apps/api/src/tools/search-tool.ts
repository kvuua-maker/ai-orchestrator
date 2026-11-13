import { z } from "zod";
import { defineTool } from "./sdk.js";

/**
 * search.web — загальний пошук в інтернеті через власний SearXNG (без ключів і лімітів).
 * Шукає будь-що: людей за ПІБ, телефони, компанії, адреси, новини, документацію.
 */

const SEARX = process.env.SEARXNG_URL ?? "http://127.0.0.1:8898";

interface Hit { title: string; url: string; snippet: string; engine: string }

async function viaSearxng(query: string, limit: number): Promise<Hit[]> {
  const url = `${SEARX}/search?q=${encodeURIComponent(query)}&format=json&language=uk-UA&safesearch=0`;
  const res = await fetch(url, { signal: AbortSignal.timeout(14_000), headers: { accept: "application/json" } });
  if (!res.ok) return [];
  const json: any = await res.json();
  return (json.results ?? []).slice(0, limit).map((r: any) => ({
    title: String(r.title ?? "").replace(/\s+/g, " ").trim(),
    url: String(r.url ?? ""),
    snippet: String(r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 260),
    engine: String((r.engines ?? [])[0] ?? r.engine ?? "searx"),
  })).filter((h: Hit) => h.url.startsWith("http"));
}

async function viaBingRss(query: string, limit: number): Promise<Hit[]> {
  const res = await fetch(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return [];
  const xml = await res.text();
  return xml.split("<item>").slice(1, limit + 1).map((b) => ({
    title: ((b.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").trim(),
    url: ((b.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? "").trim(),
    snippet: ((b.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260),
    engine: "bing",
  })).filter((h: Hit) => h.url.startsWith("http") && h.title);
}

export const searchWeb = defineTool({
  name: "search.web",
  version: "1.0.0",
  description:
    "Search the public web and return ranked results with title, URL and snippet. " +
    "Use it for ANY question that needs finding a page: a person by full name, a phone number, a company, " +
    "an address, news or documentation. Always cite the URLs you used.",
  input: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(15).optional(),
  }),
  output: z.object({
    query: z.string(),
    results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), engine: z.string() })),
    engine: z.string(),
    total: z.number(),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["web:search"], agents: ["synthesizer", "browser", "data", "verifier"],
  timeoutMs: 15_000, maxRetries: 0,
  async execute({ query, limit }) {
    const n = limit ?? 8;
    const searx = await viaSearxng(query, n).catch(() => [] as Hit[]);
    if (searx.length) return { data: { query, results: searx, engine: "searxng", total: searx.length } };

    const bing = await viaBingRss(query, n).catch(() => [] as Hit[]);
    return { data: { query, results: bing, engine: "bing-rss", total: bing.length } };
  },
  async simulate({ query }) {
    return { data: { query, results: [], engine: "simulate", total: 0 } };
  },
});
