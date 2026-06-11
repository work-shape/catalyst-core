import { createClientInstanceApp } from "@vivd-stage/client-assembly";
import { loadClientEnvironment, resolveConfigPath } from "./environment";
import { tools } from "./tool-registry";

loadClientEnvironment();

const configPath = resolveConfigPath(process.env.CLIENT_CONFIG_PATH);

const app = await createClientInstanceApp({
  configPath,
  env: process.env,
  tools
});

await app.listen();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close();
  });
}
