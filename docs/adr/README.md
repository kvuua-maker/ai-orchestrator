# Architecture Decision Records

One file per decision. **Immutable once accepted** — to change a decision, write a new ADR that supersedes
the old one. This is how we avoid re-litigating the same arguments every three months.

## Format

```
# ADR-NNNN: <short decision title>

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN | Deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** <names/roles>
- **Supersedes:** ADR-NNNN (optional)

## Context
What forces are at play? Constraints, numbers, deadlines. No opinions yet.

## Decision
We will <do X>. One paragraph, unambiguous.

## Consequences
### Positive
### Negative
### Neutral / follow-ups

## Alternatives considered
| Option | Why rejected |
```

A good ADR fits on one screen. If it needs three, the decision is probably two decisions.

## Index

| ADR | Decision | Status |
|---|---|---|
| 0001 | TypeScript monorepo instead of a Python backend | Proposed |
| 0002 | Own agent runtime instead of LangChain/CrewAI | Proposed |
| 0003 | Plan-and-Execute (DAG) instead of pure ReAct | Proposed |
| 0004 | pg-boss for MVP queues, Temporal as the migration point | Proposed |
| 0005 | Postgres + pgvector instead of a dedicated vector DB | Proposed |
| 0006 | Shared DB + RLS for multi-tenancy | Proposed |
| 0007 | Playwright + patchright as the base browser driver | Proposed |
| 0008 | 6-tier browser escalation ladder (T0–T5) | Proposed |
| 0009 | Docker + gVisor as the default sandbox | Proposed |
| 0010 | Dual-LLM (quarantined reader) for untrusted content | Proposed |
| 0011 | Own usage ledger as the source of truth for limits | Proposed |
| 0012 | Merchant of Record first, direct Stripe later | Proposed |
| 0013 | SSE instead of WebSocket for streaming | Proposed |
| 0014 | Human takeover as a first-class feature | Proposed |
| 0015 | Customer-as-operator in Terms + policy engine | Proposed |
| 0016 | Canonical CRM model + adapters instead of direct integrations | Proposed |
| 0017 | Documents: DOCX template + LibreOffice headless | Proposed |
| 0018 | Official platform APIs only; bulk account creation out of scope | Accepted |
| 0019 | Account onboarding via human takeover, no stored password | Proposed |
| 0020 | Extraction order: JSON-LD → embedded state → DOM → LLM | Proposed |
| 0021 | Account Vault: three-level key hierarchy, write-only secrets | Proposed |
| 0022 | Telegram: Bot API for outbound, userbot inbound-only | Accepted |
| 0023 | A module is a tool pack, never its own infrastructure | Accepted |
| 0024 | Effectively-once: at-least-once + idempotency key + outbox | Accepted |
| 0025 | Reconciliation as a standard job; CRM is source of truth for leads | Accepted |
| 0026 | Fencing tokens for run leases | Accepted |
| 0027 | Content contract per source: distinguish blocked from empty | Accepted |
| 0028 | Never write unvalidated data to canonical tables | Accepted |
| 0029 | Big bang = one release, 8 parallel tracks, walking skeleton | Accepted |
| 0030 | Universality = Zero-Core-Change Test + synthetic domain in CI | Accepted |
| 0031 | Monetisation is post-processing; never influences selection | Accepted |
| 0032 | Revenue (`revenue_events`) accounted separately from cost (`usage_events`) | Accepted |
| 0033 | Data Confirmation — HITL on data, separate from action approval | Accepted |
| 0034 | Files: virtual filesystem (Postgres + content-addressed S3) | Accepted |
| 0035 | Reporting via versioned templates, no tax logic in code | Accepted |
| 0036 | Google Workspace is a P0 launch blocker | Accepted |
| 0037 | Dry-run mode as a mandatory tool contract | Accepted |
| 0038 | Onboarding: first result BEFORE connecting accounts | Accepted |
| 0039 | Error messages carry three parts: what, why, what to do | Accepted |
| 0040 | Proactive suggestions: ≤1/week, opt-in, no finance categories | Accepted |
| 0041 | Secrets: AES-256-GCM + AAD, KEK in KMS, per-tenant DEK, 15-min cache | Accepted |
| 0042 | `[SECRET_INJECTED]` as mandatory marker in all logs and events | Accepted |
| 0043 | Chat secret detector blocks LLM send, offers save-and-purge | Accepted |
| 0044 | Set & Forget: no preventive rotation, react only to real failures | Accepted |

Each row above has a matching section in [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) §31.1 and a
full argument in the relevant chapter.

## When to write one

Write an ADR when the decision is **expensive to reverse** or **likely to be questioned later**.
Do not write one for naming a variable.

Typical triggers: choosing a database, a queue, a framework, an isolation model, a pricing model, or a
public API shape. Also: any decision that a future engineer would look at and ask "why on earth?".
