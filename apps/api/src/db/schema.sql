CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL,
  prompt text NOT NULL,
  goal_spec jsonb,
  plan jsonb,
  budget jsonb NOT NULL,
  spent_usd numeric(12,4) NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  dry_run boolean NOT NULL DEFAULT false,
  next_seq integer NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS runs_tenant_updated_idx ON runs (tenant_id, updated_at DESC, id);
CREATE TABLE IF NOT EXISTS run_events (
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  agent text NOT NULL,
  goal text NOT NULL,
  est_cost_usd numeric(12,4) NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_run_idx ON tasks (run_id);
CREATE TABLE IF NOT EXISTS tool_invocations (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  task_id text NOT NULL,
  tool text NOT NULL,
  args_hash text NOT NULL,
  status text NOT NULL,
  cost_micros bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  tenant_id text NOT NULL,
  endpoint text NOT NULL,
  response jsonb NOT NULL,
  status_code integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  platform text NOT NULL,
  apns_token text NOT NULL,
  app_version text,
  locale text,
  timezone text,
  push_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, apns_token)
);
CREATE TABLE IF NOT EXISTS secrets (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS uploads (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  file_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- RLS: ізоляція тенантів на рівні БД (§7.2.1)
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY runs_tenant ON runs USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY devices_tenant ON devices USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY secrets_tenant ON secrets USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS artifacts (
  key text PRIMARY KEY,
  tenant_id text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_tenant_idx ON artifacts (tenant_id, created_at DESC);

-- ── Пам'ять і RAG (§10) ──
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS memory_chunks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  embedding real[] NOT NULL,
  tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS memory_chunks_trgm_idx ON memory_chunks USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memory_chunks_tenant_idx ON memory_chunks (tenant_id, created_at DESC);

-- Косинусна подібність для real[] (працює без pgvector)
CREATE OR REPLACE FUNCTION cosine_similarity(a real[], b real[])
RETURNS double precision AS $$
DECLARE
  s double precision := 0; na double precision := 0; nb double precision := 0; i integer;
BEGIN
  IF array_length(a, 1) IS DISTINCT FROM array_length(b, 1) THEN RETURN 0; END IF;
  FOR i IN 1..array_length(a, 1) LOOP
    s := s + a[i] * b[i];
    na := na + a[i] * a[i];
    nb := nb + b[i] * b[i];
  END LOOP;
  IF na = 0 OR nb = 0 THEN RETURN 0; END IF;
  RETURN s / sqrt(na * nb);
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE TABLE IF NOT EXISTS response_cache (
  key text PRIMARY KEY,
  tenant_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS response_cache_tenant_idx ON response_cache (tenant_id, expires_at);

-- ── Handoff Protocol (§4.17) ──
CREATE TABLE IF NOT EXISTS handoffs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id text,
  reason text NOT NULL,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending',
  answer text,
  answer_option text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS handoffs_run_idx ON handoffs (run_id, status);
CREATE INDEX IF NOT EXISTS handoffs_tenant_idx ON handoffs (tenant_id, status, created_at DESC);

-- ── Аудит (§22.4): append-only ──
CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource text NOT NULL,
  resource_id text,
  trace_id text,
  ip text,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (tenant_id, action, created_at DESC);
