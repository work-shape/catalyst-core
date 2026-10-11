import { createEnvironmentSecrets } from "@vivd-catalyst/client-assembly";

/** The environment of the sample MCP server. The key is taken from the secret resolver. */
export function readSampleMcpEnvironment() {
  return {
    secrets: createEnvironmentSecrets(process.env),
    anchor: process.env.SAMPLE_DATA_ANCHOR,
    port: process.env.PORT,
    host: process.env.HOST
  };
}
