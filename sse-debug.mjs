import { chromium } from "playwright";
const AUTH = { username: "aio", password: "2AkXbxUcBjaYZ4" };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, httpCredentials: AUTH });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.url().includes("/stream")) console.log("STREAM RESP", r.status(), r.url().slice(-30)); });
page.on("requestfailed", (r) => { if (r.url().includes("/stream")) console.log("STREAM FAILED", r.failure()?.errorText); });
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE ERR", m.text().slice(0, 140)); });
page.on("pageerror", (e) => console.log("PAGE ERROR", String(e).slice(0, 140)));

await page.goto("http://127.0.0.1:3100/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.click("text=+ Нова").catch(() => {});
await page.waitForTimeout(1200);
await page.fill(".composer-input", "перевір ціни на iPhone 15 в Rozetka");
await page.click(".composer-send");
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(3000);
  const n = await page.locator(".step-row").count();
  const txt = await page.locator(".step-row").allInnerTexts().catch(() => []);
  console.log(`t+${(i + 1) * 3}s steps=${n}`, txt.map((t) => t.replace(/\n/g, " ").slice(0, 55)).join(" | "));
}
await page.screenshot({ path: "/tmp/sse-debug.png" });
await browser.close();
