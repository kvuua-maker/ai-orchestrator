# Розгортання (production)

Розгорнуто: 2026-11-12 на хості `ubuntu-4gb-nbg1-1` (4 vCPU, 7.7 ГБ RAM).

## Де що лежить

| Що | Шлях / адреса |
|---|---|
| Код (git clone, зібраний) | `/mnt/HC_Volume_106461592/aio/app` |
| Секрети (600) | `/mnt/HC_Volume_106461592/aio/.env` |
| База даних | Docker `aio-postgres-1`, том `…/aio/pgdata`, `127.0.0.1:55433` |
| Пул з'єднань | Docker `aio-pgbouncer-1`, `127.0.0.1:6433`, `pool_mode=transaction`, `default_pool_size=40` |
| API | systemd `aio-api`, `127.0.0.1:4100` |
| Web | systemd `aio-web`, `127.0.0.1:3100` |
| Артефакти | `…/aio/artifacts` (content-addressed) |
| Бекапи | `…/aio/backups`, таймер `aio-backup.timer` (щодня 03:30, ротація 7 днів) |
| Пісочниця | образ `aio/sandbox-base:latest` (318 МБ), gVisor `runsc release-20261109.0` |

**Чому на томі, а не на корені:** кореневий диск `/` заповнений на 91% (3.3 ГБ вільно) і там живе
MarketApp. Усі дані й збірка — на `/mnt/HC_Volume_106461592` (40 ГБ, вільно 29 ГБ).

## Керування

```bash
systemctl status aio-api aio-web aio-backup.timer
systemctl restart aio-api            # після зміни .env
journalctl -u aio-api -f             # логи (структурований JSON з trace-id)

cd /mnt/HC_Volume_106461592/aio
docker compose ps                    # postgres + pgbouncer
docker compose logs -f postgres
```

Оновлення коду:

```bash
cd /mnt/HC_Volume_106461592/aio/app
git pull --ff-only
npm ci --no-audit --no-fund && npx tsc -b && npx next build apps/web
cp apps/api/src/db/schema.sql apps/api/dist/db/schema.sql
cp apps/api/src/db/rls.sql   apps/api/dist/db/rls.sql
systemctl restart aio-api aio-web
```

Міграція БД (після зміни `schema.sql` / `rls.sql`):

```bash
set -a; . /mnt/HC_Volume_106461592/aio/.env; set +a
PG_ADMIN_URL="postgres://aio:$PG_SUPER_PASSWORD@127.0.0.1:55433/postgres" \
DATABASE_URL="postgres://aio_app:$AIO_APP_PASSWORD@127.0.0.1:55433/aio" \
node scripts/db-bootstrap.mjs
```

> `bootstrap` ідемпотентний: створює ролі, вмикає `ENABLE + FORCE RLS`, засіває плани.

## Перевірка після деплою

```bash
curl -s http://127.0.0.1:4100/healthz          # {"ok":true,"driver":"pg"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/

set -a; . /mnt/HC_Volume_106461592/aio/.env; set +a
AUDIT_DB_URL="postgres://aio:$PG_SUPER_PASSWORD@127.0.0.1:55433/aio" \
DATABASE_URL="postgres://aio_app:$AIO_APP_PASSWORD@127.0.0.1:55433/aio" \
AIO_ENV_FILE=/mnt/HC_Volume_106461592/aio/.env \
node scripts/security-audit.mjs | tail -5     # очікується 21/21
```

## gVisor

```bash
docker run --rm --runtime=runsc alpine uname -r     # → 4.19.0-gvisor
docker run --rm --runtime=runsc --network=none --read-only --cap-drop=ALL \
  --user=10001:10001 aio/sandbox-base:latest node -e 'console.log(process.getuid())'
```

`runsc` встановлено в `/usr/local/bin/runsc`, допоміжні бінарники — `/usr/local/bin/gvisor-bin/`,
runtime зареєстровано в `/etc/docker/daemon.json`.

**Важливо:** драйвер пісочниці в коді вмикається змінною `SANDBOX_DRIVER=docker`, але **поки не
використовується** — у поточному наборі інструментів немає виконання коду. Образ і runtime готові
до появи таких інструментів.

## Бекапи

```bash
/usr/local/bin/aio-backup.sh          # ручний запуск
systemctl list-timers aio-backup.timer
```

Скрипт перевіряє дамп через `pg_restore -l` і падає з помилкою, якщо дамп нечитабельний.
**Копія на інший сервер не налаштована** — бекап лежить на тому ж томі.

## Що НЕ зроблено (публічний доступ)

API і Web слухають `127.0.0.1` — назовні не відкриті. Для публічного доступу потрібно:

1. Домен (наприклад `ai.<ваш-домен>`) + DNS A-запис.
2. Сайт у nginx (поруч із `vakansio`, `universalassistant`) з проксі на `127.0.0.1:3100` і `/v1` → `4100`.
3. TLS (certbot) і `WEB_ORIGIN=https://<домен>` у `.env`, потім `systemctl restart aio-api aio-web`.

Без домену я не чіпав nginx — щоб не зачепити конфігурацію MarketApp/Vakansio.
