import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { gzipSync } from "node:zlib";

const BUCKET = "solhunt-artifacts";

export interface ContractRow {
  address: string;
  chain: string;
  name: string;
  block_number?: number;
  vuln_class?: string;
  description?: string;
  date_exploited?: string;
  value_impacted?: string;
  reference_exploit?: string;
  source_storage_path?: string;
}

export interface ScanRunRow {
  contract_id: string;
  benchmark_run_id?: string;
  provider: string;
  model: string;
  found: boolean | null;
  vuln_class?: string;
  severity?: string;
  functions?: string[];
  description?: string;
  test_passed?: boolean;
  value_at_risk?: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  iterations: number;
  max_iterations: number;
  error?: string;
  class_match?: boolean;
  exploit_code_path?: string;
  forge_output_path?: string;
  conversation_path?: string;
  recon_data_path?: string;
  hostname?: string;
}

export interface BenchmarkRunRow {
  provider: string;
  model: string;
  dataset_hash?: string;
  total: number;
  exploited: number;
  success_rate: number;
  total_cost: number;
  avg_cost: number;
  errors: number;
  hostname?: string;
}

export interface ToolCallRow {
  scan_run_id: string;
  iteration: number;
  tool_name: string;
  duration_ms?: number;
  is_error: boolean;
  summary?: string;
}

let client: SupabaseClient | null = null;

export function isEnabled(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

export function getClient(): SupabaseClient | null {
  if (!isEnabled()) return null;
  if (!client) {
    client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    );
  }
  return client;
}

export async function upsertContract(row: ContractRow): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from("contracts")
      .upsert(row, { onConflict: "address,chain,block_number" })
      .select("id")
      .single();

    if (error) {
      console.error(`[storage] upsertContract error: ${error.message}`);
      return null;
    }
    return data?.id ?? null;
  } catch (err: any) {
    console.error(`[storage] upsertContract failed: ${err.message}`);
    return null;
  }
}

export async function insertScanRun(row: ScanRunRow): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from("scan_runs")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      console.error(`[storage] insertScanRun error: ${error.message}`);
      return null;
    }
    return data?.id ?? null;
  } catch (err: any) {
    console.error(`[storage] insertScanRun failed: ${err.message}`);
    return null;
  }
}

export async function insertToolCalls(calls: ToolCallRow[]): Promise<void> {
  const sb = getClient();
  if (!sb || calls.length === 0) return;

  try {
    const { error } = await sb.from("tool_calls").insert(calls);
    if (error) {
      console.error(`[storage] insertToolCalls error: ${error.message}`);
    }
  } catch (err: any) {
    console.error(`[storage] insertToolCalls failed: ${err.message}`);
  }
}

export async function insertBenchmarkRun(
  row: BenchmarkRunRow
): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from("benchmark_runs")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      console.error(`[storage] insertBenchmarkRun error: ${error.message}`);
      return null;
    }
    return data?.id ?? null;
  } catch (err: any) {
    console.error(`[storage] insertBenchmarkRun failed: ${err.message}`);
    return null;
  }
}

export async function updateBenchmarkRun(
  id: string,
  updates: Partial<BenchmarkRunRow>
): Promise<void> {
  const sb = getClient();
  if (!sb) return;

  try {
    const { error } = await sb
      .from("benchmark_runs")
      .update(updates)
      .eq("id", id);

    if (error) {
      console.error(`[storage] updateBenchmarkRun error: ${error.message}`);
    }
  } catch (err: any) {
    console.error(`[storage] updateBenchmarkRun failed: ${err.message}`);
  }
}

export async function uploadArtifact(
  path: string,
  data: string | Buffer,
  contentType = "application/octet-stream"
): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;

  try {
    const body = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    const { error } = await sb.storage
      .from(BUCKET)
      .upload(path, body, { contentType, upsert: true });

    if (error) {
      console.error(`[storage] uploadArtifact error (${path}): ${error.message}`);
      return null;
    }
    return path;
  } catch (err: any) {
    console.error(`[storage] uploadArtifact failed (${path}): ${err.message}`);
    return null;
  }
}

export function gzipJson(obj: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(obj), "utf-8"));
}
