# AI-Orchestrator

Multi-agent SaaS: the user types a request in a chat, the system plans it, executes it with real tools
(browser, code sandbox, shell, HTTP APIs) and returns artifacts.

> **Status: architecture phase.** No application code yet. See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Repository layout (target)

```
apps/
  web/          Next.js dashboard + chat UI
  api/          Fastify control plane (auth, tenants, billing, runs API)
  worker/       Agent runtime + tool executors (Node) — scales horizontally
packages/
  agent-core/   Planner, executor loop, run state machine, model router
  tools/        Tool registry + tool implementations (browser, shell, http, ...)
  shared/       Types, zod schemas, event contracts, shared utils
infra/
  docker/       Local dev compose (postgres, redis, minio, browser-runner)
  terraform/    Cloud infra (later)
docs/
  adr/          Architecture decision records
  research/     Research notes feeding ARCHITECTURE.md
```

## Read first

1. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the full technical plan, all components, roadmap.
2. `docs/adr/` — the individual decisions, one file each, immutable once accepted.

## Local dev (once milestone 2 lands)

```bash
pnpm install
cp .env.example .env
pnpm db:up          # postgres + redis + minio + browser-runner
pnpm dev
```

## Non-negotiables

- Every tenant is isolated at the data layer (RLS) **and** the compute layer (own sandbox namespace).
- Secrets are never placed in an LLM prompt. Tools receive capability handles, not credentials.
- Untrusted web content is never concatenated into the privileged reasoning context.
- Every tool call is auditable: who, what, which run, which arguments hash, which result.
