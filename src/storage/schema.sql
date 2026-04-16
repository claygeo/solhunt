-- Solhunt Data Persistence Schema
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/xogipstirlipvoaabbid/sql

-- contracts table (reference data, one row per unique contract)
CREATE TABLE IF NOT EXISTS contracts (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  address       TEXT NOT NULL,
  chain         TEXT NOT NULL,
  name          TEXT NOT NULL,
  block_number  BIGINT,
  vuln_class    TEXT,
  description   TEXT,
  date_exploited TEXT,
  value_impacted TEXT,
  reference_exploit TEXT,
  source_storage_path TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(address, chain, block_number)
);

-- benchmark_runs table (groups scans into benchmark executions)
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  dataset_hash TEXT,
  total       INTEGER NOT NULL,
  exploited   INTEGER NOT NULL DEFAULT 0,
  success_rate NUMERIC(5,4) DEFAULT 0,
  total_cost  NUMERIC(10,4) DEFAULT 0,
  avg_cost    NUMERIC(10,4) DEFAULT 0,
  errors      INTEGER DEFAULT 0,
  hostname    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- scan_runs table (one row per scan execution, core analytics)
CREATE TABLE IF NOT EXISTS scan_runs (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id     UUID REFERENCES contracts(id),
  benchmark_run_id UUID REFERENCES benchmark_runs(id),
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  found           BOOLEAN,
  vuln_class      TEXT,
  severity        TEXT,
  functions       TEXT[],
  description     TEXT,
  test_passed     BOOLEAN,
  value_at_risk   TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  iterations      INTEGER NOT NULL DEFAULT 0,
  max_iterations  INTEGER NOT NULL DEFAULT 30,
  error           TEXT,
  class_match     BOOLEAN,
  exploit_code_path    TEXT,
  forge_output_path    TEXT,
  conversation_path    TEXT,
  recon_data_path      TEXT,
  hostname        TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_model ON scan_runs(model);
CREATE INDEX IF NOT EXISTS idx_scan_runs_contract ON scan_runs(contract_id);
CREATE INDEX IF NOT EXISTS idx_scan_runs_vuln_class ON scan_runs(vuln_class);
CREATE INDEX IF NOT EXISTS idx_scan_runs_found ON scan_runs(found);
CREATE INDEX IF NOT EXISTS idx_scan_runs_created ON scan_runs(created_at);

-- tool_calls table (per-iteration tool usage log)
CREATE TABLE IF NOT EXISTS tool_calls (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scan_run_id UUID REFERENCES scan_runs(id) ON DELETE CASCADE,
  iteration   INTEGER NOT NULL,
  tool_name   TEXT NOT NULL,
  duration_ms INTEGER,
  is_error    BOOLEAN DEFAULT false,
  summary     TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(scan_run_id);
