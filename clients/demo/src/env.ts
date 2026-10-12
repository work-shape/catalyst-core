import { createEnvironmentSecrets } from "@vivd-catalyst/client-assembly";

/** The environment of the sample MCP server. The key is taken from the secret resolver. */
export function readSampleMcpEnvironment() {
  return {
    secrets: createEnvironmentSecrets(process.env),
    anchor: process.env.SAMPLE_DATA_ANCHOR,
    accountingLastMonth: process.env.SAMPLE_ACCOUNTING_LAST_MONTH,
    port: process.env.PORT,
    host: process.env.HOST
  };
}

/** The environment of a command of the demo that runs on the host, such as `pnpm demo:seed`. */
export function hostEnvironment(): Readonly<Record<string, string | undefined>> {
  return process.env;
}
