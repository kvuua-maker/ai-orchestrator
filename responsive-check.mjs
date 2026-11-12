import { chromium } from "playwright";

const AUTH = { username: "aio", password: "2AkXbxUcBjaYZ4" };
const URL = "http://127.0.0.1:3100/";
const DEVICES = [
  { name: "iPhone 13", width: 390, height: 844, dpr: 3 },
  { name: "iPhone SE", width: 375, height: 667, dpr: 2 },
  { name: "iPad mini", width: 744, height: 1133, dpr: 2 },
  { name: "iPad Pro 11", width: 834, height: 1194, dpr: 2 },
  { name: "Desktop", width: 1440, height: 900, dpr: 1 },
];

const browser = await chromium.launch();
const out = [];

for (const d of DEVICES) {
  const ctx = await browser.newContext({
    viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr,
    isMobile: d.width < 900, hasTouch: d.width < 900, httpCredentials: AUTH,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 100)));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".composer-input", { timeout: 15000 });

  // реальне повідомлення → перевіряємо бульбашки і стрім
  await page.fill(".composer-input", "Що ти вмієш?");
  await page.click(".composer-send");
  await page.waitForSelector(".bubble-bot", { timeout: 60000 });
  await page.waitForTimeout(12000);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const bubbles = [...document.querySelectorAll(".bubble")].map((b) => b.getBoundingClientRect());
    const composer = document.querySelector(".chat-composer")?.getBoundingClientRect();
    const send = document.querySelector(".composer-send")?.getBoundingClientRect();
    return {
      scrollW: de.scrollWidth, innerW: window.innerWidth,
      bubbles: bubbles.length,
      maxBubbleRight: Math.round(Math.max(...bubbles.map((b) => b.right), 0)),
      minBubbleW: Math.round(Math.min(...bubbles.map((b) => b.width), 9999)),
      composerBottom: composer ? Math.round(composer.bottom) : null,
      composerInView: composer ? composer.bottom <= window.innerHeight + 2 : false,
      sendInView: send ? send.right <= window.innerWidth + 1 : false,
      sidebarOffscreen: (() => { const s = document.querySelector(".chat-sidebar"); if (!s) return true;
        const st = getComputedStyle(s); return st.position === "fixed" ? st.transform !== "none" : false; })(),
    };
  });
  await page.screenshot({ path: `/tmp/shot2-${d.width}.png` });

  // бургер відкриває меню?
  let burgerWorks = null;
  if (d.width < 900) {
    await page.click(".chat-toggle");
    await page.waitForTimeout(400);
    burgerWorks = await page.evaluate(() => {
      const s = document.querySelector(".chat-sidebar");
      return s ? getComputedStyle(s).transform === "matrix(1, 0, 0, 1, 0, 0)" || s.classList.contains("open") : false;
    });
    await page.screenshot({ path: `/tmp/shot2-menu-${d.width}.png` });
    await page.click(".chat-overlay").catch(() => {});
  }

  out.push({ device: d.name, ...m, overflowX: m.scrollW - m.innerW, burgerWorks, errors });
  await ctx.close();
}
await browser.close();

let bad = 0;
for (const r of out) {
  const ok = r.overflowX <= 1 && r.composerInView && r.sendInView && r.errors.length === 0 && r.minBubbleW > 30 && r.maxBubbleRight <= r.innerW;
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} ${r.device.padEnd(11)} overflow=${r.overflowX} composer=${r.composerInView ? "ok" : "ЗА ЕКРАНОМ"} send=${r.sendInView ? "ok" : "ОБРІЗАНО"} бульбашок=${r.bubbles} minW=${r.minBubbleW} maxRight=${r.maxBubbleRight}/${r.innerW}${r.burgerWorks !== null ? ` бургер=${r.burgerWorks ? "ok" : "НЕ ПРАЦЮЄ"}` : ""}${r.errors.length ? " ERR:" + r.errors.join(";") : ""}`);
}
console.log(bad === 0 ? "\n✅ УСІ В'ЮПОРТИ OK" : `\n❌ ПРОБЛЕМИ: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
