import { z } from "zod";
import pg from "pg";
import { defineTool } from "./sdk.js";

/** Локальні реєстри: ПДВ і ФОП. Без ключів, без інтернету. */

let pool: pg.Pool | null = null;
// діагностика: якщо рядка немає — кидаємо зрозумілу помилку
function db(): pg.Pool {
  if (!pool) {
    if (!(process.env.EDR_DATABASE_URL ?? process.env.DATABASE_URL)) throw new Error("DATABASE_URL missing");
    pool = new pg.Pool({ connectionString: process.env.EDR_DATABASE_URL ?? process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 30_000 });
  }
  return pool;
}

export async function vatFind(query: string, limit = 5) {
  const q = query.trim();
  if (/^\d{8,12}$/.test(q)) {
    const { rows } = await db().query(
      `SELECT kod_pdv, name, registered_at, terminated_at FROM vat_payers WHERE kod_pdv=$1 LIMIT $2`, [q, limit]);
    return rows;
  }
  const clean = q.replace(/(^|\s)(тов|тзов|фоп|пп|дп|кп|ат)(?=\s|$)/gi, " ").replace(/[«»"'()]/g, " ").replace(/\s{2,}/g, " ").trim().toLowerCase();
  const { rows } = await db().query(
    `SELECT kod_pdv, name, registered_at, terminated_at FROM vat_payers
      WHERE lower(name) LIKE $1 ORDER BY (terminated_at='') DESC LIMIT $2`, [`%${clean}%`, limit]);
  return rows;
}

export async function fopFind(query: string, limit = 5) {
  const clean = query.replace(/[«»"'()]/g, " ").replace(/\s{2,}/g, " ").trim().toLowerCase();
  const { rows } = await db().query(
    `SELECT record, name, status, registered_at FROM edr_fop
      WHERE lower(name) LIKE $1 ORDER BY (status <> 'припинено') DESC, length(name) ASC LIMIT $2`, [`%${clean}%`, limit]);
  return rows;
}

export const vatCheck = defineTool({
  name: "vat.check",
  version: "1.0.0",
  description:
    "Check whether a Ukrainian entity is a VAT payer using the official registry stored locally (281k records). " +
    "Accepts a tax code (8-12 digits) or a company name; returns the code, name and registration date.",
  input: z.object({ query: z.string().min(2) }),
  output: z.object({
    query: z.string(),
    found: z.number(),
    items: z.array(z.object({ kod_pdv: z.string(), name: z.string(), registered_at: z.string().nullable(), terminated_at: z.string().nullable() })),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["registry:read"], agents: ["synthesizer", "data", "verifier"],
  timeoutMs: 8_000, maxRetries: 0,
  async execute({ query }) {
    const items = await vatFind(query).catch(() => []);
    return { data: { query, found: items.length, items: items as any } };
  },
  async simulate({ query }) { return { data: { query, found: 0, items: [] } }; },
});

export const fopLookup = defineTool({
  name: "fop.lookup",
  version: "1.0.0",
  description:
    "Search the official Ukrainian register of individual entrepreneurs (ФОП) stored locally. " +
    "Accepts a person's full name; returns status and registration date.",
  input: z.object({ query: z.string().min(3) }),
  output: z.object({
    query: z.string(),
    found: z.number(),
    items: z.array(z.object({ record: z.string(), name: z.string(), status: z.string().nullable(), registered_at: z.string().nullable() })),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["registry:read"], agents: ["synthesizer", "data", "verifier"],
  timeoutMs: 8_000, maxRetries: 0,
  async execute({ query }) {
    const items = await fopFind(query).catch(() => []);
    return { data: { query, found: items.length, items: items as any } };
  },
  async simulate({ query }) { return { data: { query, found: 0, items: [] } }; },
});
