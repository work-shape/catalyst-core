import {
  defineClientInstance,
  type ClientInstanceApp,
  type ClientInstanceCapability,
  type ConnectorTypeDefinition
} from "@work-shape/catalyst-client-assembly";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { demoTools } from "../tools";
import { folderSourceConnector } from "./e2e-folder-source";
import { heldSkillSaves } from "./policy";

// The API the browser suite runs against: the demo, with one changing tool and the central
// policy setting that sends its calls to another person for approval, and one whose calls the
// person the run acts for confirms. Further settings hold a skill saved into a Shared Workspace
// named `E2E held skills`, which one test creates and deletes; they hold nothing while no
// workspace has that name. No screen sets a central setting before
// Instance > Policies exists (OP-2), so the suite's server names both.
// It also names the suite's Connector types, which reach nothing, and ships the four
// general skills as a capability of a deployment does, without the commands they name.
// `pnpm dev:demo` and the demo's own server do not load this file.

const HELD_TOOL = "e2e.record_note";
const HELD_WORKSPACE = "E2E held skills";

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

// Held for the confirmation of the person the run acts for (EW-2): the run pauses on it, and
// the conversation shows the host's card with Allow and Deny.
const CONFIRMED_TOOL = "e2e.confirm_note";

const confirmNote = defineTool({
  name: CONFIRMED_TOOL,
  effect: "changing",
  // Runs on the agent's own call. The central setting below asks the person first.
  permission: { mode: "allow" },
  description: "Records a note once the person allows it. A fixture of the browser suite.",
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

// The four general skills as a deployment ships them with the artifact helpers of the
// capabilities repo, which the demo does not hold: the names, titles, summaries and icons, and a
// line of text each.
const generalSkills: ClientInstanceCapability = {
  name: "e2e-general-skills",
  skills: [
    {
      name: "spreadsheets",
      title: "Spreadsheets",
      summary:
        "Knows how to build a spreadsheet that calculates, and to check it before handing it over.",
      icon: "spreadsheet"
    },
    {
      name: "documents",
      title: "Documents",
      summary: "Knows how to lay out a Word document and check it page by page.",
      icon: "document"
    },
    {
      name: "presentations",
      title: "Presentations",
      summary: "Knows how to build a slide deck and check every slide.",
      icon: "presentation"
    },
    {
      name: "pdf",
      title: "PDF",
      summary: "Knows how to read, fill and assemble PDFs, and to verify the result.",
      icon: "pdf"
    }
  ].map((skill) => ({
    ...skill,
    description: `Use for ${skill.title}. A fixture of the browser suite.`,
    content: `# ${skill.title}`
  })),
  create: () => ({})
};

const client = defineClientInstance({
  rootDir: new URL("..", import.meta.url),
  tools: [...demoTools, recordNote, confirmNote],
  connectorTypes: [testConnector, folderSourceConnector],
  capabilities: [generalSkills]
});

// The settings read the instance's workspaces, which they find here once `listen` answers.
const running: { app?: ClientInstanceApp } = {};
const app = await client.listen({
  operations: {
    centralPolicySettings: async () => [
      { operation: HELD_TOOL, value: "approval" },
      { operation: CONFIRMED_TOOL, value: "confirm" },
      ...(await heldSkillSaves(running.app, HELD_WORKSPACE))
    ]
  }
});
running.app = app;

// A second API of one spec shares the suite's database and is stopped when that spec ends. It
// says so here and takes nothing from the queues: a job or an Agent Run of another spec that it
// held would end with it. What it took before this line it finishes; it takes no more.
if (client.loadEnvironment().E2E_TAKES_NO_JOBS === "1") {
  const drainMs = 60_000;
  await Promise.all([app.jobs.stop({ drainMs }), app.agentRunJobs?.stop({ drainMs })]);
}
