// One process of an instance, started the way a built entry point is. The first argument names
// the process and the second one the build: whether it has a capability that ships the
// `documents` module, and whether that module needs a job kind of the workspace command worker.
// The release gate's `--resolve-only` may follow.
import { defineCapability } from "@work-shape/catalyst-capability-sdk";
import { defineClientInstance } from "@work-shape/catalyst-client-assembly";
import { defineModule } from "@work-shape/catalyst-core";

const [name, build] = process.argv.slice(2);
const documents = defineCapability({
  name: "documents-stand-in",
  configKey: "documentProcessing",
  modules: [
    defineModule({
      name: "documents",
      tools: ["read_document"],
      ...(build === "with-capability-that-needs-the-command-worker"
        ? { jobKinds: ["documents.render"], commandWorkerJobKinds: ["documents.render"] }
        : {})
    })
  ],
  create: () => ({})
});
const client = defineClientInstance({
  rootDir: process.cwd(),
  loadEnv: false,
  capabilities: build === "without-capability" ? [] : [documents]
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
