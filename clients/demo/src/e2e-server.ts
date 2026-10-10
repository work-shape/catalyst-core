import { defineClientInstance } from "@vivd-catalyst/client-assembly";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { z } from "zod";
import { demoTools } from "../tools";

// The API the browser suite runs against: the demo, with one changing tool and the central
// policy setting that sends its calls to another person for approval. No screen sets a
// central setting before Instance > Policies exists (OP-2), so the suite's server names it.
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

const client = defineClientInstance({
  rootDir: new URL("..", import.meta.url),
  tools: [...demoTools, recordNote]
});

await client.listen({
  operations: { centralPolicySettings: () => [{ operation: HELD_TOOL, value: "approval" }] }
});
