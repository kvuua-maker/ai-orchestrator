import { chromium } from "playwright";
const AUTH = { username: "aio", password: "2AkXbxUcBjaYZ4" };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, isMobile: true, hasTouch: true, httpCredentials: AUTH });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:3100/", { waitUntil: "domcontentloaded" });
await page.click("text=+ Нова").catch(() => {});
await page.waitForTimeout(400);
await page.fill(".composer-input", "перевір ціни на iPhone 15 в Rozetka і Comfy");

const mark = {}; const t0 = Date.now();
const poll = setInterval(async () => {
  try {
    if (!mark.timer && await page.locator("text=/⏱ \\d{2}:\\d{2}/").first().isVisible().catch(() => false)) mark.timer = Date.now() - t0;
    if (!mark.plan && await page.locator(".bubble-bot").count().then(c => c > 0).catch(() => false)) mark.plan = Date.now() - t0;
    if (!mark.step && await page.locator(".step-row").count().then(c => c > 0).catch(() => false)) mark.step = Date.now() - t0;
  } catch {}
}, 120);
await page.click(".composer-send");
await page.waitForTimeout(26000);
clearInterval(poll);
const steps = await page.locator(".step-row").allInnerTexts().catch(() => []);
const timerText = await page.locator("text=/⏱ \\d{2}:\\d{2}/").first().innerText().catch(() => "");
const stopVisible = await page.locator("button", { hasText: "Стоп" }).first().isVisible().catch(() => false);
await page.screenshot({ path: "/tmp/final-run.png" });
console.log(JSON.stringify({ marks: mark, timer: timerText, stopVisible, steps: steps.map(s => s.replace(/\n/g, " ")).slice(0, 8), stepsTotal: steps.length }, null, 1));
await browser.close();
