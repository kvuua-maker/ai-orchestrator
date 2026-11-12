import { chromium } from "playwright";
const AUTH = { username: "aio", password: "2AkXbxUcBjaYZ4" };
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 834, height: 1194 }, isMobile: true, hasTouch: true, httpCredentials: AUTH });
const p = await c.newPage();
await p.goto("http://127.0.0.1:3100/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2000);
await p.click("text=+ Нова").catch(() => {});
await p.waitForTimeout(600);
await p.fill(".composer-input", "перевір https://example.com і https://github.com та порівняй");
await p.click(".composer-send");
await p.waitForTimeout(9000);
const info = {
  timer: await p.locator("text=/⏱ \\d{2}:\\d{2}/").first().innerText().catch(() => "—"),
  stop: await p.locator("button", { hasText: "Стоп" }).first().isVisible().catch(() => false),
  plan: (await p.locator(".bubble-bot").last().innerText().catch(() => "")).slice(0, 120).replace(/\n/g, " "),
  steps: await p.locator(".step-row").allInnerTexts().catch(() => []),
};
await p.screenshot({ path: "/tmp/running2.png" });
console.log(JSON.stringify(info, null, 1));
await b.close();
