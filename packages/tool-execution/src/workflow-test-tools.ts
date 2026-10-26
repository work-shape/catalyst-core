import { defineTool, toolFailed, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/** Agent projections of existing Workflow operations, never separate tool operations. */
export const WORKFLOW_TEST_TOOL_NAMES: readonly string[] = [
  "workflows.test",
  "workflows.get_run",
  "workflows.list_step_runs"
];

/**
 * These tools are descriptions for the model. The tool runner calls their registered
 * operations directly: the same rights, policy, input validation and run as the API.
 * In particular no tool projects `assets.run_live_once` or starts a published Workflow.
 */
export function createWorkflowTestTools(): AnyToolDefinition[] {
  const presentation = { group: "platform", icon: "workflow" } as const;
  const runId = z.string().min(1).describe("The id returned by workflows.test.");
  const execute = () =>
    toolFailed("handler_failed", "Call Workflow tools through the operation runner");
  return [
    defineTool({
      ...presentation,
      name: "workflows.test",
      title: { en: "Test Workflow draft", de: "Workflow-Entwurf testen" },
      effect: "changing",
      permission: { mode: "allow" },
      description: [
        "Start a test run of the saved draft of the Workflow this conversation is about, or of one this conversation created, with the input its definition asks for (read it with platform.assets.get first). It runs as the person, bounded by the Workflow's service principal, needs their workflow.write right, and never publishes.",
        "Reading steps read live; changing steps are simulated unless the called asset has a test target. Only a person sets Run live once: a switched step that needs confirmation is refused, so ask them to start that test from the canvas.",
        "Follow it with workflows.get_run and workflows.list_step_runs, and report what would have been written and any refusal."
      ].join(" "),
      inputSchema: z.object({
        workflow: z
          .string()
          .min(1)
          .describe("The subject Workflow, or a draft this conversation created."),
        input: z.record(z.string(), z.unknown())
      }),
      execute
    }),
    defineTool({
      ...presentation,
      name: "workflows.get_run",
      title: { en: "Read Workflow Run", de: "Workflow-Lauf lesen" },
      effect: "reading",
      description:
        "Read a Workflow Run by its id: status, mode, who started it, error and result preview. After workflows.test, check whether it ended, then read its steps with workflows.list_step_runs.",
      inputSchema: z.object({ runId }),
      execute
    }),
    defineTool({
      ...presentation,
      name: "workflows.list_step_runs",
      title: { en: "Read Workflow step results", de: "Workflow-Schrittergebnisse lesen" },
      effect: "reading",
      description:
        "Read a page of a Workflow Run's steps in order, with status, target, error and result preview. Target dry_run means Simulated: outputPreview says what it wouldHaveDone. Follow nextCursor until no page remains, steps in loops and blocks included.",
      inputSchema: z.object({
        runId,
        limit: z.string().optional().describe("Page size, up to 200."),
        cursor: z.string().optional().describe("The previous page's nextCursor, if present.")
      }),
      execute
    })
  ];
}
