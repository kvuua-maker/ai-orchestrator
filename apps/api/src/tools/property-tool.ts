import { z } from "zod";
import { defineTool } from "./sdk.js";

/**
 * property.lookup — пошук об'єкта нерухомості та його власника за адресою.
 *
 * Джерела (за наявності ключа в .env):
 *   OPENDATABOT_API_KEY — офіційний API Opendatabot (послуга «перевірка нерухомості»)
 *   SCANBE_API_KEY      — scanbe.io (агрегатор реєстрів, легальний доступ до ДРРП)
 *
 * Без ключа інструмент чесно повертає, що саме потрібно для доступу, і не вигадує власника:
 * ДРРП — це персональні дані, публічного пошуку «адреса → ПІБ» не існує.
 */

interface OwnerInfo {
  address: string;
  objectType: string | null;
  area: string | null;
  owners: Array<{ name: string; share: string | null; type: string | null }>;
  encumbrances: string[];
  source: string;
  url: string | null;
}

async function viaOpendatabot(address: string): Promise<OwnerInfo | null> {
  const { resolveKey } = await import("../integrations/store.js");
  const key = resolveKey("opendatabot") ?? process.env.OPENDATABOT_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.opendatabot.com/api/v3/realestate/search?q=${encodeURIComponent(address)}&apiKey=${key}`,
      { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const item = json?.data?.[0];
    if (!item) return null;
    return {
      address: item.address ?? address,
      objectType: item.type ?? null,
      area: item.total_area ?? null,
      owners: (item.owners ?? []).map((o: any) => ({ name: o.name ?? "—", share: o.share ?? null, type: o.type ?? null })),
      encumbrances: item.encumbrances ?? [],
      source: "Opendatabot API",
      url: item.url ?? null,
    };
  } catch { return null; }
}

async function viaScanbe(address: string): Promise<OwnerInfo | null> {
  const { resolveKey } = await import("../integrations/store.js");
  const key = resolveKey("scanbe") ?? process.env.SCANBE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://scanbe.io/api/v1/realestate?address=${encodeURIComponent(address)}&key=${key}`,
      { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const item = json?.data ?? json?.results?.[0];
    if (!item) return null;
    return {
      address: item.address ?? address,
      objectType: item.object_type ?? null,
      area: item.area ?? null,
      owners: (item.owners ?? []).map((o: any) => ({ name: o.name ?? o.full_name ?? "—", share: o.share ?? null, type: o.owner_type ?? null })),
      encumbrances: item.encumbrances ?? [],
      source: "scanbe.io API",
      url: item.link ?? null,
    };
  } catch { return null; }
}

export const propertyLookup = defineTool({
  name: "property.lookup",
  version: "1.0.0",
  description:
    "Look up a real-estate object and its owner by address through a licensed registry provider " +
    "(Opendatabot API or scanbe.io). Returns object type, area, owners with shares and encumbrances. " +
    "Requires OPENDATABOT_API_KEY or SCANBE_API_KEY; without a key it explains the official route instead of guessing.",
  input: z.object({
    address: z.string().min(5),
    city: z.string().optional(),
  }),
  output: z.object({
    query: z.string(),
    found: z.boolean(),
    property: z.object({
      address: z.string(), objectType: z.string().nullable(), area: z.string().nullable(),
      owners: z.array(z.object({ name: z.string(), share: z.string().nullable(), type: z.string().nullable() })),
      encumbrances: z.array(z.string()), source: z.string(), url: z.string().nullable(),
    }).nullable(),
    hint: z.string().nullable(),
  }),
  risk: "read", effectClass: "pure", costClass: "cheap",
  scopes: ["registry:read"], agents: ["synthesizer", "data", "verifier"],
  timeoutMs: 20_000, maxRetries: 0,
  async execute({ address, city }) {
    const q = city ? `${city}, ${address}` : address;
    for (const fn of [viaOpendatabot, viaScanbe]) {
      const p = await fn(q).catch(() => null);
      if (p) return { data: { query: q, found: true, property: p, hint: null } };
    }
    const { resolveKey: rk } = await import("../integrations/store.js");
    const hasKey = Boolean(rk("opendatabot") || rk("scanbe") || process.env.OPENDATABOT_API_KEY || process.env.SCANBE_API_KEY);
    return {
      data: {
        query: q, found: false, property: null,
        hint: hasKey
          ? "Провайдер не повернув даних за цією адресою. Перевірте формат: «місто, вулиця, будинок»."
          : "ДРРП не має публічного пошуку «адреса → ПІБ»: це персональні дані. Потрібен ключ Opendatabot (послуга нерухомості) або scanbe.io, або офіційний витяг через Мін'юст/нотаріуса.",
      },
    };
  },
  async simulate({ address }) {
    return { data: { query: address, found: false, property: null, hint: "simulated" } };
  },
});
