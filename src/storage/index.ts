export {
  isEnabled,
  getClient,
  upsertContract,
  insertScanRun,
  insertToolCalls,
  insertBenchmarkRun,
  updateBenchmarkRun,
  uploadArtifact,
  gzipJson,
  type ContractRow,
  type ScanRunRow,
  type BenchmarkRunRow,
  type ToolCallRow,
} from "./supabase.js";

export { DataCollector, summarizeToolCall } from "./collector.js";
