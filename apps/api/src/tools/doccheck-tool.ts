import { z } from "zod";
import { defineTool } from "./sdk.js";

/**
 * doccheck.check — перевірка дійсності документа через ОФІЦІЙНИЙ сервіс.
 * Обидва сервіси (МВС і ДМС) захищені CAPTCHA/Cloudflare, тому відкриваємо їх
 * у «живому браузері»: людина вводить номер сама, агент читає результат.
 */

const SERVICES = {
  license: {
    name: "Перевірка посвідчення водія (МВС)",
    url: "https://solutions.mvs.gov.ua/check-driver-license",
    what: "серія та номер посвідчення → дійсність, категорії, строк дії",
  },
  passport: {
    name: "Перевірка недійсних документів (ДМС)",
    url: "https://dmsu.gov.ua/services/nd.html",
    what: "паспорт/ID-картка → чи не визнаний недійсним, втраченим або викраденим",
  },
} as const;

export const docCheck = defineTool({
  name: "doccheck.check",
  version: "1.0.0",
  description:
    "Open the official Ukrainian service that verifies a driver's licence or a passport. " +
    "Both services require CAPTCHA, so this opens the real page in the live browser for the person " +
    "to type the document number; the agent then reads the result from the same session.",
  input: z.object({
    kind: z.enum(["license", "passport"]),
    series: z.string().optional(),
    number: z.string().optional(),
  }),
  output: z.object({
    kind: z.string(),
    service: z.string(),
    url: z.string(),
    vnc: z.string().nullable(),
    note: z.string(),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["browser:read"], agents: ["synthesizer", "data", "verifier"],
  timeoutMs: 20_000, maxRetries: 0,
  async execute({ kind, series, number }) {
    const svc = SERVICES[kind];
    const { ensureLiveBrowser, vncInfo } = await import("../live/session.js");
    await ensureLiveBrowser(svc.url);
    const v = vncInfo();

    // заповнюємо поля за користувача (капчу лишаємо людині — це її дія)
    if (kind === "license" && (series || number)) {
      try {
        const { chromium } = await import("playwright");
        const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
        const page = b.contexts()[0]?.pages()[0];
        if (page) {
          if (series) await page.fill("input[name='series']", series.toUpperCase()).catch(() => {});
          if (number) await page.fill("input[name='number']", number).catch(() => {});
        }
      } catch { /* поля не критичні */ }
    }
    return {
      data: {
        kind, service: svc.name, url: svc.url, vnc: v.url,
        note: `${svc.what}. Сервіс захищений CAPTCHA, тому відкрито у живому браузері — введіть номер там.`,
      },
    };
  },
  async simulate({ kind }) {
    const svc = SERVICES[kind as "license" | "passport"];
    return { data: { kind, service: svc.name, url: svc.url, vnc: null, note: "simulated" } };
  },
});
