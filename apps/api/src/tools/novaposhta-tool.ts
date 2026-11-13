import { z } from "zod";
import { defineTool, ToolFailure } from "./sdk.js";

/**
 * novaposhta.* — створення ТТН і відстеження через API Нової Пошти (v2.0).
 * Ключ додається на сторінці «Підключення» (provider: novaposhta).
 */

async function npCall(key: string, model: string, method: string, props: Record<string, unknown>) {
  const res = await fetch("https://api.novaposhta.ua/v2.0/json/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: key, modelName: model, calledMethod: method, methodProperties: props }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => { throw new ToolFailure("UPSTREAM_ERROR", `Нова Пошта недоступна: ${e?.message ?? e}`, true); });
  const json: any = await res.json().catch(() => ({}));
  if (!json?.success) {
    const msg = (json?.errors ?? []).join("; ") || `HTTP ${res.status}`;
    throw new ToolFailure("UPSTREAM_ERROR", `Нова Пошта: ${msg}`, false);
  }
  return json.data as any[];
}

function key(): string {
  // синхронно: ключ уже в кеші інтеграцій
  const { cachedKey } = require("../integrations/store.js");
  const k = cachedKey("novaposhta") ?? process.env.NOVAPOSHTA_API_KEY;
  if (!k) throw new ToolFailure("AUTH", "Нова Пошта не підключена: додайте API-ключ на сторінці «Підключення».", false);
  return k;
}

export const novaposhtaTrack = defineTool({
  name: "novaposhta.track",
  version: "1.0.0",
  description: "Track a Nova Poshta parcel by its TTN number and return the current status.",
  input: z.object({ ttn: z.string().min(10).max(30) }),
  output: z.object({ ttn: z.string(), status: z.string(), statusCode: z.string().nullable() }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["logistics:read"], agents: ["synthesizer", "data"],
  timeoutMs: 25_000, maxRetries: 0,
  async execute({ ttn }) {
    const data = await npCall(key(), "TrackingDocument", "getStatusDocuments", {
      Documents: [{ DocumentNumber: ttn }],
    });
    const d = data?.[0] ?? {};
    return { data: { ttn, status: String(d.Status ?? "невідомо"), statusCode: d.StatusCode ? String(d.StatusCode) : null } };
  },
  async simulate({ ttn }) { return { data: { ttn, status: "dry-run", statusCode: null } }; },
});

export const novaposhtaCreateTtn = defineTool({
  name: "novaposhta.create_ttn",
  version: "1.0.0",
  description:
    "Create a Nova Poshta waybill (ТТН): needs sender and recipient city + warehouse names, payer type and cost. " +
    "Returns the TTN number and a tracking link.",
  input: z.object({
    senderCity: z.string().min(2),
    senderWarehouse: z.string().min(2),
    recipientName: z.string().min(2),
    recipientPhone: z.string().min(9),
    recipientCity: z.string().min(2),
    recipientWarehouse: z.string().min(2),
    cost: z.number().min(1).optional(),
    weight: z.number().min(0.1).max(1000).optional(),
    description: z.string().max(200).optional(),
  }),
  output: z.object({ ttn: z.string(), cost: z.string().nullable(), link: z.string() }),
  risk: "write", effectClass: "non_idempotent", costClass: "cheap",
  scopes: ["logistics:write"], agents: ["synthesizer", "data"],
  timeoutMs: 60_000, maxRetries: 0,
  async execute(input) {
    const k = key();
    const cities = await npCall(k, "Address", "searchSettlements", { CityName: input.senderCity, Limit: "1" });
    const senderCityRef = cities?.[0]?.Addresses?.[0]?.Ref;
    const cities2 = await npCall(k, "Address", "searchSettlements", { CityName: input.recipientCity, Limit: "1" });
    const recipientCityRef = cities2?.[0]?.Addresses?.[0]?.Ref;
    if (!senderCityRef || !recipientCityRef) throw new ToolFailure("NOT_FOUND", "Не знайдено місто відправника або отримувача.", false);

    const docs = await npCall(k, "InternetDocument", "save", {
      PayerType: "Recipient", PaymentMethod: "Cash", DateTime: new Date().toLocaleDateString("uk-UA"),
      CargoType: "Cargo", Weight: String(input.weight ?? 0.5), ServiceType: "WarehouseWarehouse",
      SeatsAmount: "1", Description: input.description ?? "Товар", Cost: String(input.cost ?? 500),
      CitySender: senderCityRef, Sender: "", SenderAddress: "",
      SenderWarehouseIndex: input.senderWarehouse, RecipientCityName: input.recipientCity,
      RecipientArea: "", RecipientAreaRegions: "", RecipientAddressName: input.recipientWarehouse,
      RecipientHouse: "", RecipientFlat: "", RecipientName: input.recipientName,
      RecipientType: "PrivatePerson", RecipientsPhone: input.recipientPhone.replace(/[^\d+]/g, ""),
      CityRecipient: recipientCityRef,
    });
    const d = docs?.[0] ?? {};
    const ttn = String(d.IntDocNumber ?? "");
    return { data: { ttn, cost: d.CostOnSite ? String(d.CostOnSite) : null, link: `https://tracking.novaposhta.ua/#/uk/tracking/${ttn}` } };
  },
  async simulate() { return { data: { ttn: "dry-run", cost: null, link: "" } }; },
});
