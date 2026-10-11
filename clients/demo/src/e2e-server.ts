import { defineClientInstance, type ConnectorTypeDefinition } from "@vivd-catalyst/client-assembly";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { z } from "zod";
import { demoTools } from "../tools";

// The API the browser suite runs against: the demo, with one changing tool and the central
// policy setting that sends its calls to another person for approval. No screen sets a
// central setting before Instance > Policies exists (OP-2), so the suite's server names it.
// It also names the one Connector type of the suite, which reaches nothing.
// `pnpm dev:demo` and the demo's own server do not load this file.

const HELD_TOOL = "e2e.record_note";

const recordNote = defineTool({
  name: HELD_TOOL,
  effect: "changing",
  // Runs on the agent's own call. Without a mode the instance default for changes would apply.
  permission: { mode: "allow" },
  description: "Records a note. A fixture of the browser suite: it stores nothing.",
  inputSchema: z.object({ text: z.string().min(1) }),
  outputSchema: z.object({ recorded: z.string() }),
  execute: (input) => toolSuccess({ recorded: input.text })
});

const connectorSettings = z.object({ url: z.string().url().startsWith("https://") }).strict();

// A Connector type for the suite's Connections. It contacts nothing: `test` answers ready and
// a call returns its input. Its target is still checked against the instance's egress list.
const testConnector: ConnectorTypeDefinition = {
  type: "test",
  description: "Returns what it is given. A fixture of the browser suite: it reaches nothing.",
  settingsSchema: connectorSettings,
  authSchemes: ["none", "bearer"],
  secretFields: ["token"],
  target(settings) {
    const url = new URL(connectorSettings.parse(settings).url);
    return {
      protocol: "https",
      host: url.hostname,
      port: url.port === "" ? 443 : Number(url.port)
    };
  },
  catalog: [
    {
      name: "echo",
      description: "Returns its input.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 200 } },
        required: ["text"],
        additionalProperties: false
      },
      outputSchema: { type: "object" },
      proposedEffect: "reading"
    },
    {
      name: "record",
      description: "Returns its input as if it had changed something outside.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 200 } },
        required: ["text"],
        additionalProperties: false
      },
      outputSchema: { type: "object" },
      proposedEffect: "changing"
    }
  ],
  test: () => Promise.resolve({ status: "ready" }),
  execute: (_operation, input) => Promise.resolve(input),
  limits: { callTimeoutMs: 5_000, resultMaxBytes: 16 * 1024, maxParallelCalls: 4 }
};

const client = defineClientInstance({
  rootDir: new URL("..", import.meta.url),
  tools: [...demoTools, recordNote],
  connectorTypes: [testConnector]
});

const app = await client.listen({
  operations: { centralPolicySettings: () => [{ operation: HELD_TOOL, value: "approval" }] }
});

// A second API of one spec shares the suite's database and is stopped when that spec ends. It
// says so here and takes nothing from the queues: a job or an Agent Run of another spec that it
// held would end with it. What it took before this line it finishes; it takes no more.
if (client.loadEnvironment().E2E_TAKES_NO_JOBS === "1") {
  const drainMs = 60_000;
  await Promise.all([app.jobs.stop({ drainMs }), app.agentRunJobs?.stop({ drainMs })]);
}
