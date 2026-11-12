# Інфраструктура

| Файл | Призначення |
|---|---|
| `docker/docker-compose.dev.yml` | Postgres, PgBouncer, Redis, MinIO, збірка образу пісочниці |
| `docker/sandbox.Dockerfile` | базовий образ для `Sandbox` (§5.3) |
| `pgbouncer/pgbouncer.ini` | transaction pooling, `default_pool_size=50` (§33.4.1) |

## gVisor

`DockerSandbox` запускає контейнери з `--runtime=runsc`. Щоб це працювало, на хості:

```bash
# 1. встановити runsc (інструкції: gvisor.dev/docs/user_guide/install)
# 2. додати runtime у /etc/docker/daemon.json
{ "runtimes": { "runsc": { "path": "/usr/bin/runsc" } } }
# 3. перезапустити docker
```

Без `runsc` контейнер запуститься на `runc` — ізоляція слабша, і проєкт це не приховує:
`SANDBOX_DRIVER=docker` вмикає docker-драйвер, `process` (за замовчуванням у dev) — без ізоляції ядра.

## Артефакти

`ARTIFACT_DRIVER=local` (за замовчуванням) — content-addressed файли в `ARTIFACT_ROOT`.
Для S3/MinIO потрібні `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` —
драйвер реалізується за тим самим інтерфейсом `ArtifactStore`.
