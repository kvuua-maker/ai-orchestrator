import { z } from "zod";
import pg from "pg";
import { defineTool } from "./sdk.js";

/**
 * edr.lookup — офіційний ЄДР, завантажений локально (2 млн записів).
 * Без ключів, без інтернету, без CAPTCHA: відповідь за мілісекунди.
 */

let pool: pg.Pool | null = null;
// діагностика: якщо рядка немає — кидаємо зрозумілу помилку
function db(): pg.Pool {
  if (!pool) {
    if (!(process.env.EDR_DATABASE_URL ?? process.env.DATABASE_URL)) throw new Error("DATABASE_URL missing");
    pool = new pg.Pool({
      connectionString: process.env.EDR_DATABASE_URL ?? process.env.DATABASE_URL,
      max: 3, idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export interface EdrRow {
  edrpou: string; name: string; short_name: string | null; opf: string | null;
  status: string | null; director: string | null; registered_at: string | null;
}

export async function edrFind(query: string, limit = 5): Promise<EdrRow[]> {
  const q = query.trim();
  if (/^\d{8,10}$/.test(q)) {
    const { rows } = await db().query<EdrRow>(
      `SELECT edrpou,name,short_name,opf,status,director,registered_at FROM edr_subjects WHERE edrpou=$1 LIMIT $2`, [q, limit]);
    return rows;
  }
  // прибираємо ОПФ, лапки й дієслова-команди, шукаємо за триграмами
  const stop = /^(перевір|знайди|покажи|дай|що|таке|компанію|компанія|фірму|реєстр|реєстрі|інформацію|про|по|чи|є|в|у|на|з|для)$/i;
  const clean = q.replace(/(^|\s)(тов|тзов|пат|фоп|дп|кп|пп|ат|prat|пpат)(?=\s|$)/gi, " ")
    .replace(/[«»"'()]/g, " ").replace(/\s{2,}/g, " ").trim();
  const sql = `SELECT edrpou,name,short_name,opf,status,director,registered_at
                 FROM edr_subjects
                WHERE lower(name) LIKE $1 OR lower(short_name) LIKE $1
                ORDER BY (status <> 'припинено') DESC, length(name) ASC
                LIMIT $2`;
  let { rows } = await db().query<EdrRow>(sql, [`%${clean.toLowerCase()}%`, limit]);
  if (rows.length) return rows;

  // фолбек: пробуємо окремі значущі слова («перевір компанію АТБ в реєстрі» → АТБ)
  const words = clean.split(/[\s,]+/).map((w) => w.trim()).filter((w) => w.length >= 3 && !stop.test(w));
  for (const w of words.sort((a, b) => b.length - a.length).slice(0, 3)) {
    ({ rows } = await db().query<EdrRow>(sql, [`%${w.toLowerCase()}%`, limit]));
    if (rows.length) return rows;
  }
  return [];
}

export const edrLookup = defineTool({
  name: "edr.lookup",
  version: "1.0.0",
  description:
    "Search the official Ukrainian EDR registry stored locally (2 million entities) by company name or ЄДРПОУ. " +
    "Returns official name, code, status and director instantly, without internet or keys.",
  input: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(10).optional() }),
  output: z.object({
    query: z.string(),
    found: z.number(),
    items: z.array(z.object({
      edrpou: z.string(), name: z.string(), short_name: z.string().nullable(),
      opf: z.string().nullable(), status: z.string().nullable(),
      director: z.string().nullable(), registered_at: z.string().nullable(),
    })),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["registry:read"], agents: ["synthesizer", "data", "verifier", "browser"],
  timeoutMs: 8_000, maxRetries: 0,
  async execute({ query, limit }) {
    const items = await edrFind(query, limit ?? 5).catch((e) => { console.error("[edr]", e?.message ?? e); return []; });
    return { data: { query, found: items.length, items } };
  },
  async simulate({ query }) { return { data: { query, found: 0, items: [] } }; },
});
