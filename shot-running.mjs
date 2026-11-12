import { chromium } from "playwright";
const AUTH = { username: "aio", password: "2AkXbxUcBjaYZ4" };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, isMobile: true, hasTouch: true, httpCredentials: AUTH });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:3100/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2200);
await page.click("text=+ Нова").catch(() => {});
await page.waitForTimeout(800);
await page.fill(".composer-input", "порівняй ціни на iPhone 15 в Rozetka і Comfy");
await page.click(".composer-send");
await page.waitForTimeout(6500);
await page.screenshot({ path: "/tmp/running.png" });
const info = {
  timer: await page.locator("text=/⏱ \\d{2}:\\d{2}/").first().innerText().catch(() => "—"),
  stop: await page.locator("button", { hasText: "Стоп" }).first().isVisible().catch(() => false),
  steps: await page.locator(".step-row").allInnerTexts().catch(() => []),
};
console.log(JSON.stringify(info, null, 1));
await browser.close();
