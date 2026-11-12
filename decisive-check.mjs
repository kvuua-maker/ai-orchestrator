import { chromium } from "playwright";
const AUTH = { username: "aio", password: "2AkXbxUcBjaYZ4" };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, isMobile: true, hasTouch: true, httpCredentials: AUTH });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:3100/", { waitUntil: "domcontentloaded" });

// нова розмова, щоб не тягнути історію
await page.click("text=+ Нова").catch(() => {});
await page.waitForTimeout(500);
await page.fill(".composer-input", "перевір ціни на iPhone");
const t0 = Date.now();
await page.click(".composer-send");

// 1) чи немає кнопок-варіантів (допиту)
await page.waitForTimeout(6000);
const options = await page.locator("button", { hasText: /Сайт постачальника|Свій кабінет|Уточніть/ }).count();
const botText = await page.locator(".bubble-bot").last().innerText().catch(() => "");

// 2) чи з'явився таймер і кнопка стоп
const timerVisible = await page.locator("text=/⏱ \\d{2}:\\d{2}/").first().isVisible().catch(() => false);
const stopVisible = await page.locator("button", { hasText: "Стоп" }).first().isVisible().catch(() => false);
const stepsCount = await page.locator("div", { hasText: /^⏳|^✓/ }).count().catch(() => 0);
await page.screenshot({ path: "/tmp/decisive-running.png" });

// 3) стоп
let stopped = false;
if (stopVisible) {
  await page.click("button:has-text('Стоп')");
  await page.waitForTimeout(2500);
  stopped = await page.locator("text=Зупинено вами").first().isVisible().catch(() => false);
  await page.screenshot({ path: "/tmp/decisive-stopped.png" });
}

console.log(JSON.stringify({
  msToFirstResponse: Date.now() - t0,
  clarifyButtons: options,
  botSaid: botText.slice(0, 160).replace(/\n/g, " "),
  timerVisible, stopVisible, stepsCount, stopped,
}, null, 1));
await browser.close();
