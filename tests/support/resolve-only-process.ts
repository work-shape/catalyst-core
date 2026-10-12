// One process of an instance, started the way the release gate starts a built entry point. The
// first argument names the process. The build has a capability that ships the `documents`
// module when the second one is `with-capability`.
import { defineCapability } from "@vivd-catalyst/capability-sdk";
import { defineClientInstance } from "@vivd-catalyst/client-assembly";
import { defineModule } from "@vivd-catalyst/core";

const [name, build] = process.argv.slice(2);
const client = defineClientInstance({
  rootDir: process.cwd(),
  loadEnv: false,
  capabilities:
    build === "with-capability"
      ? [
          defineCapability({
            name: "documents-stand-in",
            configKey: "documentProcessing",
            modules: [defineModule({ name: "documents", tools: ["read_document"] })],
            create: () => ({})
          })
        ]
      : []
});
const processes: Record<string, () => Promise<unknown>> = {
  server: () => client.listen(),
  "agent-run-worker": () => client.runAgentRunWorker(),
  "workspace-command-worker": () => client.runWorkspaceCommandWorker(),
  "artifact-preview-worker": () => client.runArtifactPreviewWorker()
};
const run = processes[name ?? ""];
if (!run) throw new Error(`Unknown process '${name}'`);
await run();
