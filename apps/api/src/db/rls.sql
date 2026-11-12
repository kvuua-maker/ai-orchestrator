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

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;   -- ENABLE обов'язковий: FORCE сам по собі не вмикає
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON artifacts TO aio_app;
DO $$ BEGIN
  CREATE POLICY artifacts_tenant ON artifacts FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;   -- ENABLE обов'язковий: FORCE сам по собі не вмикає
ALTER TABLE memory_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE response_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_cache FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_chunks TO aio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON response_cache TO aio_app;
DO $$ BEGIN
  CREATE POLICY memory_chunks_tenant ON memory_chunks FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY response_cache_tenant ON response_cache FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON handoffs TO aio_app;
DO $$ BEGIN
  CREATE POLICY handoffs_tenant ON handoffs FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Сервісна роль для фонових задач: бачить усі тенанти, але це явна політика, а не bypass
DO $$ BEGIN CREATE ROLE aio_svc LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE aio_svc NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO aio_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aio_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aio_svc;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['runs','run_events','tasks','devices','secrets','artifacts','memory_chunks','response_cache','handoffs','audit_log'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY svc_all ON %I FOR ALL TO aio_svc USING (true) WITH CHECK (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

-- Аудит: застосунок може лише читати й дописувати (append-only)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON audit_log FROM aio_app, aio_svc;
GRANT SELECT, INSERT ON audit_log TO aio_app;
DO $$ BEGIN
  CREATE POLICY audit_tenant ON audit_log FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY; ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY; ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY; ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions, usage_events, invoices TO aio_app;
GRANT SELECT ON plans TO aio_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions','usage_events','invoices'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I_tenant ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t, t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY; ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY; ALTER TABLE messages FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations, messages TO aio_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','messages'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I_tenant ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t, t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;
