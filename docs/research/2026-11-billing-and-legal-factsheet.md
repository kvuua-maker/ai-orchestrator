# Research note — billing & scraping law (2026-11)

> Working notes feeding `ARCHITECTURE.md` §7.6 and §8.5. Not a legal opinion.
> Verified 2026-11-10. Re-verify prices and case status before commercial use.

## A. SaaS billing for AI products

### A1. Stripe Billing — what it does and where it stops

1. Hybrid pricing = flat recurring item + metered item. Since API `2025-03-31.basil` legacy usage billing
   is deleted; metered prices must reference a **Billing Meter** (`recurring.meter`). A meter = event name
   + aggregation (`sum`/`count`/`last`) + customer mapping (`by_id`) + value key; values must be numeric
   strings.
2. Reporting is `POST /v1/billing/meter_events` with a body-level `identifier` (idempotency) and
   `timestamp`. **It is asynchronous: a 2xx means "accepted", not "recorded".** Silent drops only surface
   via the `v1.billing.meter.error_report_triggered` webhook. Backdating limit 35 days; corrections via
   `meter_event_adjustment` within ~24 h.
3. Aggregation runs at period close into an invoice line item — **there is no real-time balance**, so you
   cannot gate a request on Stripe's meter. "Credits" in Stripe are an invoice credit balance, not a
   per-request spendable wallet.
4. No native minimum-invoice floor — emulate with a minimum-spend item.
5. Stripe Tax ≈ 0.5% per transaction; usage taxability varies by jurisdiction; registrations remain ours.
6. Fees: Billing 0.7% of billing volume + processing (2.9% + 30¢ US, +1.5% international).
7. Weak at: hard real-time enforcement, prepaid wallets/auto-recharge, commitments/drawdown,
   multi-dimensional credits, usage-spike dunning.

### A2. Alternatives

| Option | Model | Economics | Fit |
|---|---|---|---|
| **Lago** (AGPL-3.0, self-host) | Charges + **wallets** (prepaid credits, auto-recharge, thresholds) | Infra cost only | Best OSS fit for credit pricing |
| **Polar** (MoR) | Seller of record, remits global indirect tax | 5% + 50¢ starter; tiered 3.8/3.6/3.4% + 40/35/30¢; +1.5% intl | Strong for a solo founder |
| **Paddle** (MoR) | Same | 5% + 50¢ | Mature, VAT/GST, chargebacks |
| **Lemon Squeezy** (MoR) | Same; acquired by Stripe 2024 | 5% + 50¢ | Fine, but direction uncertain |
| **Metronome / Orb** | Enterprise rating (real-time ingest, commits, previews) | Not public; ~% of billed volume (market practice) | Later, if enterprise |
| **OpenMeter** (Apache-2.0) | Metering + entitlements, **not** a biller | Infra cost only | Pair with Stripe |

### A3. Architecture consequences

1. Append-only ledger keyed by `(tenant_id, request_id)`: model, in/out/cached tokens, `price_version`,
   `cost_micros`. Versioned price table so historical cost is recomputable.
2. Budget guard: pre-flight reserve `prompt_tokens + max_tokens` in Redis (Lua CAS) or a Postgres row
   lock; settle on actual usage; release the delta. Hard stop = clamp `max_tokens`, abort stream, 402.
   **Enforce in a gateway/proxy, not scattered in app code.**
3. Reconcile nightly: local sum vs Stripe `meter_event_summary`; tolerance band; adjustments referencing
   the original `identifier`.
4. Idempotency: `Idempotency-Key` on Stripe POSTs, `identifier` on meter events, webhook dedupe on
   `event.id`, transactional outbox. Test clocks + upcoming-invoice for dry runs.

### A4. Crypto (optional)

Stripe stablecoin (USDC on Base/Solana/Polygon/Ethereum, 1.5%), Coinbase Commerce (1%, self-custody),
NOWPayments (0.5%, 300+ assets). Best fit: **prepaid credit top-ups** — irreversible, no chargebacks.

---

## B. Legal risk of automated scraping / bot evasion

### B1. US cases

| Case | Holding | Weight |
|---|---|---|
| *Van Buren v. United States* (2021) | CFAA "exceeds authorized access" = gates-up/gates-down; improper purpose alone is not CFAA | **Controlling** |
| *hiQ Labs v. LinkedIn* (9th Cir. 2022) | Public data is not access "without authorization"; injunction vacated. hiQ still lost the user-agreement claim; settled Dec 2022 | **Persuasive, 9th Cir.** |
| *Meta v. Bright Data* (N.D. Cal. 2024) | Logged-out scraping; contract claims dismissed (terms not shown to bind); Meta voluntarily dismissed Feb 2024 | No appellate precedent |
| *X Corp v. Bright Data* (N.D. Cal. 2024) | Dismissed; contract failed on assent, copyright preempted | No appellate precedent |
| *Ryanair v. Booking.com* (D. Del.) | Jury found CFAA violation (Jul 2024) — first civil scraping trial; **JMOL for Booking (Jan 2025)**; appeal **pending** (3d Cir. 25-1374) | **Unresolved — do not cite as final** |
| *Southwest v. Kiwi.com* (N.D. Tex.) | Declined early injunctive relief; doubted site terms bound a non-account scraper | Persuasive |
| *LinkedIn v. Mantheos* (N.D. Cal. 2025–26) | Access via fake accounts behind login: contract + CFAA theories advanced | **The practical line** |

**Dicta to internalise:** after a cease-and-desist, even public-data access can become "unauthorized".
A C&D is a legal event that changes the posture. → We need a 24-hour C&D process that auto-adds the
domain to a global deny list.

### B2. Decisive distinctions

1. **Logged-out public data:** CFAA weak, contract needs notice + assent, copyright thin — but EU database
   right, GDPR and residual ToS claims survive.
2. **Logged-in:** authorization revocable (C&D, account termination); contract binds via account
   acceptance; CFAA viable; add breach of confidence.
3. **Trespass to chattels:** needs proven harm; rarely wins.
4. **EU database right** (Dir. 96/9/EC): substantial investment in obtaining/verifying; 15 years; bars
   substantial extraction *and* repeated insubstantial extraction.
5. **GDPR:** scraped personal data is processing; Art. 6 basis (usually 6(1)(f) with a documented LIA) +
   Art. 14 notice within one month.

### B3. EU angles

1. Art. 14(5)(b) "disproportionate effort" is narrow — publish a notice naming source categories anyway;
   honour Art. 21 objections; Art. 9 data is effectively a no.
2. **DSA** (2022/2065): no general scraping ban; Art. 40 vetted-researcher access; notice-and-action
   duties (Art. 16).
3. **Data Act** (2023/2854, applies 12 Sep 2025): access/sharing for connected products and cloud
   switching — pushes API-first norms.
4. **Trade Secrets Directive** (2016/943): scraping lawful absent breach of confidence.

### B4. Contractual mitigations

1. **Customer-as-operator:** customer warrants rights and lawful basis, indemnifies us; we sell tooling,
   not data.
2. **AUP:** no CAPTCHA circumvention, no logged-in bypass, no special-category PII, domain deny lists,
   purpose limits.
3. **robots.txt knob:** obey by default; ignore only under written customer warranty.
4. **Verified opt-out:** DNS TXT / email domain verification, 24–72 h SLA, blocklist propagation.
5. **DMCA §512 / DSA Art. 16** notice-and-action; audit log (domain, time, robots version, decision) kept
   12 months; tech E&O / cyber insurance — **check scraping/CFAA exclusions**, most policies have them.

### B5. Compliance engineering

1. Per-domain policy object evaluated **pre-fetch**: allow/deny, robots mode, max RPS, max pages, auth
   policy, PII fields; log every decision.
2. RFC 9309 parser, cached TTL; treat 401/403 as disallow. No shared logged-in sessions across tenants,
   no credential storage; per-tenant egress identity.
3. Minimisation: field allowlist, hashed identifiers, retention TTL, DSR export/delete.

---

## Sources

- Stripe usage-based billing — https://docs.stripe.com/billing/subscriptions/usage-based
- Stripe Billing meters API — https://docs.stripe.com/api/billing/meter
- Polar fees — https://polar.sh/docs/merchant-of-record/fees
- Ryanair JMOL coverage — https://www.irishlegal.com/articles/judge-overturns-ryanairs-us-court-win-against-bookingcom
- RCFP case summary (Ryanair) — https://www.rcfp.org/briefs-comments/ryanair-v-booking-com/
- hiQ settlement — https://www.privacyworld.blog/2022/12/linkedins-data-scraping-battle-with-hiq-labs-ends-with-proposed-judgment/
- Meta v. Bright Data dismissal — https://brightdata.com.br/blog/general/meta-dismisses-claim-against-bright-data
- Legal aspects of commercial scraping — https://www.scrapehero.com/data-notes/legal-aspects-of-using-commercial-web-scraping-services/

**Caveats:** Ryanair appeal (3d Cir. 25-1374) was still pending; Meta/X v. Bright Data produced no
appellate precedent (voluntary dismissal / district-court dismissal) — do not over-read them.
Metronome/Orb "% of billed volume" is market practice, not a published rate.
