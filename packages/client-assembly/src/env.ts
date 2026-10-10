/** The variables this package reads by a fixed name. */
interface NamedClientInstanceEnv {
  HOST?: string | undefined;
  PORT?: string | undefined;
  CLIENT_CONFIG_PATH?: string | undefined;
  BETTER_AUTH_URL?: string | undefined;
  CHAT_UI_ORIGIN?: string | undefined;
  AGENT_RUN_WORKER_ID?: string | undefined;
  AGENT_RUN_WORKER_CONCURRENCY?: string | undefined;
  AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS?: string | undefined;
  WORKSPACE_COMMAND_TEMP_ROOT?: string | undefined;
  WORKSPACE_COMMAND_WORKER_ID?: string | undefined;
  EXECUTION_WORKSPACE_RUNNER_IMAGE?: string | undefined;
  ARTIFACT_PREVIEW_WORKER_ID?: string | undefined;
  ARTIFACT_PREVIEW_SOFFICE_COMMAND?: string | undefined;
  ARTIFACT_PREVIEW_PDFINFO_COMMAND?: string | undefined;
  ARTIFACT_PREVIEW_PDFTOPPM_COMMAND?: string | undefined;
  ARTIFACT_PREVIEW_TEMP_ROOT?: string | undefined;
  ARTIFACT_PREVIEW_CONCURRENCY?: string | undefined;
  ARTIFACT_PREVIEW_MAX_PAGES?: string | undefined;
  ARTIFACT_PREVIEW_MAX_SOURCE_BYTES?: string | undefined;
  ARTIFACT_PREVIEW_MAX_CONVERTED_PDF_BYTES?: string | undefined;
  ARTIFACT_PREVIEW_MAX_OUTPUT_BYTES?: string | undefined;
  ARTIFACT_PREVIEW_MAX_RASTER_DIMENSION?: string | undefined;
  ARTIFACT_PREVIEW_CONVERSION_TIMEOUT_MS?: string | undefined;
  ARTIFACT_PREVIEW_RASTERIZATION_TIMEOUT_MS?: string | undefined;
  ARTIFACT_PREVIEW_DPI?: string | undefined;
}

// The names of seed-user emails and of secrets come from the instance configuration, so the
// readers of those and dotenv loading need the whole map.
export type ClientInstanceEnv = NamedClientInstanceEnv & Record<string, string | undefined>;

/** The process environment, or the map a caller supplied, which is returned as it is. */
export function readClientInstanceEnv(env?: ClientInstanceEnv): ClientInstanceEnv {
  return env ?? process.env;
}
