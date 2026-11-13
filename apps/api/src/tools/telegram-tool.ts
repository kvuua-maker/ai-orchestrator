import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { defineTool, ToolFailure } from "./sdk.js";

/**
 * telegram.lookup — запит до безкоштовного бота @opendatabot_bot через особисту сесію.
 * Повертає текст відповіді бота (ЄДРПОУ, адреса, директор, борги тощо).
 */

const SESSION_FILE = "/mnt/HC_Volume_106461592/aio/telegram.session";

async function askBot(text: string, waitMs = 25_000): Promise<string> {
  if (!existsSync(SESSION_FILE)) throw new ToolFailure("AUTH", "Немає сесії Telegram — потрібен одноразовий вхід.", false);
  const apiId = Number(process.env.TG_API_ID || 0);
  const apiHash = process.env.TG_API_HASH || "";
  if (!apiId || !apiHash) throw new ToolFailure("AUTH", "Немає TG_API_ID/TG_API_HASH.", false);

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const client = new TelegramClient(new StringSession(readFileSync(SESSION_FILE, "utf8").trim()), apiId, apiHash, { connectionRetries: 2 });
  await client.connect();
  try {
    const bot = await client.getEntity("opendatabot_bot");
    const before = new Date();
    await client.sendMessage(bot, { message: text });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      const msgs = await client.getMessages(bot, { limit: 3 });
      const fresh = msgs.find((m: any) => m.out === false && m.date * 1000 > before.getTime() - 3000);
      if (fresh?.message) return String(fresh.message);
    }
    throw new ToolFailure("TIMEOUT", "Бот не відповів за 25 с.", true);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export const telegramLookup = defineTool({
  name: "telegram.lookup",
  version: "1.0.0",
  description:
    "Ask the free @opendatabot_bot in Telegram about a Ukrainian company or person (ЄДРПОУ, address, director, debts, court cases). " +
    "Use it when company.lookup has no data or when deeper registry details are needed.",
  input: z.object({ query: z.string().min(2) }),
  output: z.object({ query: z.string(), answer: z.string() }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["telegram:read"], agents: ["synthesizer", "data", "verifier", "browser"],
  timeoutMs: 35_000, maxRetries: 0,
  async execute({ query }) {
    const answer = await askBot(query);
    return { data: { query, answer: answer.slice(0, 4000) } };
  },
  async simulate({ query }) { return { data: { query, answer: "" } }; },
});
