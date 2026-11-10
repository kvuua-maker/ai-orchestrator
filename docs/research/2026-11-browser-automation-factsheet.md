# Browser automation + anti-bot stack — fact sheet (late 2025 / 2026)

## 1. Browser control
- **Playwright 1.65** (Nov 2026) — Chromium + Firefox (Juggler protocol, not CDP) + WebKit (custom build). Bundled JS driver = easiest to fork and patch; `storageState`, persistent contexts, tracing built in. Limits: Firefox leaks track the Juggler/Firefox version; WebKit ≠ Safari.
- **Puppeteer 25.16** (Oct 2026) — Chrome/Chromium via CDP; Firefox via WebDriver BiDi (since v23); no WebKit. Smallest surface, best raw CDP access, no built-in patching (use rebrowser drop-ins).
- **Selenium 4.52** (Oct 2026) — W3C WebDriver + BiDi; all three engines. Worst for stealth: separate `chromedriver` binary, `cdc_…` globals, protocol layer not patchable; only CDP-bridging or selenium-driverless helps.
- **CDP-direct** (raw websocket) — no library artifacts, but `Runtime.enable` itself is the artifact and you rebuild waits/frames/downloads. Chrome 136+ ignores `--remote-debugging-port` unless `--user-data-dir` is non-default.
- Verdict: patched Playwright for product velocity; CDP-direct only for a hot path; Selenium only for legacy grids.

## 2. Stealth / anti-detect
- **playwright-stealth 2.0.3** (Apr 2026) — maintained community fork of the abandoned original; JS `addInitScript` evasions. Low value: detectable via `toString`/descriptor checks and worker-vs-main mismatches.
- **patchright 1.64.4** (Nov 2026, active; Python/Node/.NET) — patched Playwright driver + Chromium: no `Runtime.enable`, isolated execution context, drops `--enable-automation`, closes console/command-line leaks. Drop-in. Chromium only; some Playwright tests fail by design.
- **rebrowser-patches** — patches Puppeteer/Playwright source (Runtime.enable leak, `sourceURL=pptr:`, `UtilityScript` stack names, `navigator.webdriver`, utility-world name). Drop-ins: `rebrowser-playwright` 1.64.102, `rebrowser-puppeteer` 25.16.100 (Oct 2026). Chromium-focused; docs state stealth plugins *increase* detection (`nativeTampering`, `workerConsistency` fail).
- **nodriver 0.50.99** (Oct 2026, active) — async CDP-only Chrome driver by the undetected-chromedriver author; no WebDriver layer. Chromium only.
- **undetected-chromedriver 3.5.5** (Feb 2024) — abandoned; breaks on new Chrome/headless changes. Do not start new work on it.
- **Camoufox 0.5.9** (Nov 2026) — Firefox fork, fingerprint injection at C++ level, patched Juggler so pages cannot see Playwright, BrowserForge market-share sampling, C++ human-ish mouse. Active again after a ~1-year gap; docs admit degraded pass rates from an old Firefox base and fingerprint inconsistencies. Firefox only.
- **HTTP-only**: `curl_cffi` 0.17.0 (lexiforest, active; impersonates Chrome/Safari/Firefox JA3/JA4 + HTTP/2), `tls-client` 2.0.0 (uTLS; Chrome 120–13x profiles). `curl-impersonate` is stale. These pass static/HTML tiers only; any JS challenge kills them.

## 3. What Cloudflare checks
- JA4 TLS (JA3 retired), HTTP/2 SETTINGS/priority/pseudo-header order, header order/casing and Host-vs-SNI consistency, UA vs UA-CH vs TLS family, IP/ASN reputation and rate, canvas/WebGL/audio, `navigator.webdriver`, CDP `Runtime.enable` residue, iframe/worker consistency, input timing on interactive pages, Turnstile token.
- **No/static challenge**: `curl_cffi` + residential IP works.
- **Bot Fight Mode / SBFM**: full-page JS interstitial, no purchasable token — real browser, clean IP.
- **Managed Challenge**: silent Turnstile; a correctly fingerprinted real browser passes with no click; patched Chromium + residential IP is the working combo, failure = redirect loop.
- **Turnstile non-interactive**: needs a valid token (CapSolver/2Captcha) injected into `cf-turnstile-response` or the render callback.
- **Turnstile interactive**: token service only, or human-like click in an antidetect browser.
- Tokens: Turnstile token single-use, ~300 s TTL; `cf_clearance` bound to IP + UA (+fingerprint), ~15–30 min. Solving from a different IP/UA invalidates it. Fake Googlebot fails (rDNS). Since 2025 AI crawlers are blocked by default.

## 4. CAPTCHA services (USD per 1,000)
- **CapSolver** (published): reCAPTCHA v2 $0.80, v3 $1.00, Enterprise v2 $1.00 / v3 $3.00, Turnstile $1.20, Cloudflare Challenge $1.20, image $0.40, DataDome slider $2.50, MtCaptcha $3.00. ~3–20 s, Turnstile usually <10 s.
- **2Captcha**: ~$1 image, ~$2.99 reCAPTCHA v2/hCaptcha, ~$3 Turnstile (approx); human farm, 10–45 s.
- **Anti-Captcha**: ~$2–3 reCAPTCHA v2, ~$1 image (approx), 10–40 s.
- **YesCaptcha**: ~$0.9–1.5 reCAPTCHA v2, ~$1.2–1.5 Turnstile (approx), 5–20 s.
- **NopeCHA**: credit/subscription, ≈$0.9–1.5 equivalent (approx); extension + API, historically flaky on Turnstile.
- **DeathByCaptcha**: ~$1.4–2.9 by type (approx), slowest.
- All use submit→poll (`createTask`/`getTaskResult`) or webhook. Real constraint is solve rate on strict sites, not price.

## 5. Proxies (approx: PAYG → volume)
- **Bright Data**: residential ~$8.4/GB → ~$3.5–4.2/GB committed; 150M+ IPs; sticky session IDs (~10 min default); KYC onboarding.
- **Oxylabs**: ~$6–8/GB → ~$4/GB volume; 175M IPs; sticky; enterprise-oriented.
- **Decodo** (ex-Smartproxy): ~$2–7/GB (promo ~$2, list ~$3.5–7); 115M IPs; sticky.
- **IPRoyal**: ~$7/GB → ~$1.75–3.5/GB bulk; 32M+; sticky; no-KYC, crypto.
- **Webshare**: residential ~$4.5–7/GB; datacenter $2.99/mo per 100 IPs (blocked by Cloudflare-tier targets, fine elsewhere).
- **Mobile**: ~$2–4/IP/day or ~$8–15/GB (Bright Data, Oxylabs, IPRoyal); best trust, worst latency/cost. All majors support sticky sessions (1–30 min typical).

## 6. Browser-as-a-service
- **Browserbase**: $20/100 h, $99/500 h, overage $0.10–0.12/h, proxy $10–12/GB; identity tiers Basic/Verified, auto-CAPTCHA on paid plans, persistent contexts; Verified only on Scale.
- **Steel.dev**: $0.10/h ($0.08 Scale), proxy $10/GB ($6), CAPTCHA $3/1k ($1/1k); stealth Chromium fork = Enterprise only; sessions to 24 h (Enterprise).
- **Hyperbrowser**: $0.10/h, $10/GB proxy, credits at $0.001; stealth + proxy + CAPTCHA bundled; also sandboxes/GPU.
- **Kernel**: metered per GB-second ($0.0000167 ≈ $0.06/GB-hour; ~$0.24/h for a 4 GB browser, approx); Hobbyist $30/mo includes stealth + CAPTCHA + unmetered proxy; 150 concurrent at $200.
- **Anchor Browser**: per-task pricing plus infra; bundles stealth/proxy/CAPTCHA/auth; agent-task oriented, less raw page control.
- **Browserless**: unit-based ($0.002/unit → $0.0015 Scale; ~30 s/unit ⇒ ~$0.18–0.24/browser-hour, approx); built-in CAPTCHA solving, residential proxy 6 units/MB, Chrome/WebKit/Firefox, self-host option.
- Shared limit: none beat strict Turnstile/DataDome without residential egress + warm session; "stealth" is mostly patched Chromium plus their proxies.

## 7. Human-like behavior — empirical
- **Matters**: `isTrusted` (only real CDP/WebDriver input counts; JS clicks are flagged immediately); event order (pointerover→pointerdown→mousedown→pointerup→mouseup→click), hover before click, continuity into the target; per-key `keydown/keypress/input/keyup`; cookie/history persistence + warm-up navigation (home→search→target) — the biggest behavioral win; wheel scrolling where listeners exist.
- **Cargo cult**: Bézier mouse as primary defense (low weight vs fingerprint/TLS/IP); idle jitter; Gaussian typing; scroll-to-random-offset; `addInitScript` patching (itself a fingerprint).
- **Blocker ranking**: IP reputation/ASN ≫ TLS+HTTP/2 > fingerprint consistency > CDP artifacts > behavior. Behavior decides at account/checkout (DataDome, Forter, Sift), not at the first page gate.

## 8. Fingerprint consistency
- One stable identity per session (UA, UA-CH, platform, timezone, locale, screen, WebGL vendor/renderer, canvas/audio noise, fonts, hardwareConcurrency), matched to proxy geo and TLS family. Rotating per request is worse than a mediocre stable profile.
- **Camoufox**: C++-level injection, nothing for JS to detect; BrowserForge samples realistic market-share distributions.
- **Apify `fingerprint-suite`** (`fingerprint-generator` + `fingerprint-injector`): JS-level, fast, detectable — use for consistency, not evasion.
- **Test oracles**: CreepJS (lies/trust score), BrowserLeaks (TLS/JA3/JA4, canvas, WebGL), Pixelscan, bot.sannysoft.com, incolumitas, rebrowser-bot-detector (CDP leak), IPHey. Test from the same network path as production.
