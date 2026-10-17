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
        "Start a test run of the saved draft of the Workflow this conversation is about, and no other Workflow.",
        "Give its name as 'workflow' and the input its definition asks for as 'input'. Read its definition with platform.assets.get first.",
        "The run acts as the person you work for, bounded by the Workflow's service principal, with you as its origin. It needs the person's workflow.write right.",
        "Reading steps read live; changing steps are Simulated unless the called asset has a test target. A person's Run live once switch cannot be set by an agent; a switched step that needs confirmation is refused: ask the person to start that test from the canvas.",
        "A test starts without asking for confirmation unless an administrator made its policy stricter. It never publishes.",
        "Use workflows.get_run for progress and workflows.list_step_runs for every step's target and result. Report what would have been written, and any refusal, to the person."
      ].join(" "),
      inputSchema: z.object({
        workflow: z.string().min(1).describe("The name of the conversation's subject Workflow."),
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
        "Read a Workflow Run by its id: status, mode, person who started it, error and result preview. After workflows.test, use this to check whether the run has ended, then workflows.list_step_runs to explain each step's target and result. Reads with the person's workflow.read right.",
      inputSchema: z.object({ runId }),
      execute
    }),
    defineTool({
      ...presentation,
      name: "workflows.list_step_runs",
      title: { en: "Read Workflow step results", de: "Workflow-Schrittergebnisse lesen" },
      effect: "reading",
      description:
        "Read a page of a Workflow Run's steps in execution order, with status, target, error and result preview. A target of dry_run means Simulated: outputPreview describes what wouldHaveDone, without making the change. live means Live and test means Test. Follow nextCursor with cursor until no page remains, including steps inside loops and blocks. Reads with the person's workflow.read right.",
      inputSchema: z.object({
        runId,
        limit: z.string().optional().describe("Page size, up to 200."),
        cursor: z.string().optional().describe("The previous page's nextCursor, if present.")
      }),
      execute
    })
  ];
}
