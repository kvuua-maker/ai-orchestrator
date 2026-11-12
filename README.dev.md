# Запуск скелета

```bash
npm ci
npm run typecheck          # tsc -b (shared + api)
npm test                   # 18 тестів: contracts, smoke, 10 synthetic
npm run dev                # API на :4000 (PGlite, без зовнішньої БД)
npm run dev:web            # Next.js на :3000
```

Перевірка ланцюжка:

```bash
curl -s localhost:4000/healthz
ID=$(curl -s -H 'content-type: application/json' -H 'x-tenant-id: tnt_demo0001' \
  -X POST localhost:4000/v1/runs -d '{"prompt":"Перевір https://example.com"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["id"])')
curl -s -H 'x-tenant-id: tnt_demo0001' localhost:4000/v1/runs/$ID
curl -N -H 'x-tenant-id: tnt_demo0001' localhost:4000/v1/runs/$ID/stream
```

Для реального Postgres: `DATABASE_URL=postgres://…` (гілка `pg` у `apps/api/src/db/index.ts`).
