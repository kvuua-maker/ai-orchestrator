-- Ролі: власник схеми (міграції) і застосунок (без BYPASSRLS, не власник)
DO $$ BEGIN CREATE ROLE aio_owner LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE aio_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE aio_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO aio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aio_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aio_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aio_app;

-- FORCE: політики діють навіть для власника таблиці
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
ALTER TABLE secrets FORCE ROW LEVEL SECURITY;

-- Дочірні таблиці: політика через батьківський run
DO $$ BEGIN
  CREATE POLICY run_events_tenant ON run_events FOR ALL
  USING (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_events.run_id))
  WITH CHECK (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_events.run_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tasks_tenant ON tasks FOR ALL
  USING (EXISTS (SELECT 1 FROM runs r WHERE r.id = tasks.run_id))
  WITH CHECK (EXISTS (SELECT 1 FROM runs r WHERE r.id = tasks.run_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
