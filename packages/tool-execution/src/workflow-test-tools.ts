import { defineTool, toolFailed, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/** Agent projections of existing Workflow operations, never separate tool operations. */
export const WORKFLOW_TEST_TOOL_NAMES: readonly string[] = [
  "workflows.test",
  "workflows.list_runs",
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
  const runId = z.string().min(1).describe("A run id from workflows.list_runs or workflows.test.");
  const paging = {
    limit: z.string().optional().describe("Page size, up to 200."),
    cursor: z.string().optional().describe("The previous page's nextCursor, if present.")
  };
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
      name: "workflows.list_runs",
      title: { en: "Read Workflow run history", de: "Workflow-Laufhistorie lesen" },
      effect: "reading",
      description: [
        "List recent runs of a Workflow, newest first, with status, trigger, who started it, startedAt, finishedAt and the error's stepRunId when present. Follow nextCursor to find older runs.",
        "To diagnose a failure, open the run with workflows.get_run and read its steps with workflows.list_step_runs; do not start a new test to inspect an existing failure. Calculate elapsed duration from startedAt and finishedAt where both are present.",
        "These reads show exactly what the person may see on the Workflow's run page, including its run-data restrictions. If refused, explain the refusal in a plain sentence."
      ].join(" "),
      inputSchema: z.object({
        workflow: z.string().min(1).describe("The name of the Workflow whose runs to inspect."),
        ...paging
      }),
      execute
    }),
    defineTool({
      ...presentation,
      name: "workflows.get_run",
      title: { en: "Read Workflow Run", de: "Workflow-Lauf lesen" },
      effect: "reading",
      description:
        "Read a historical or test Workflow Run by its id: status, mode, trigger, who started it, start and finish times, error and permitted result preview. Find historical runs with workflows.list_runs, then read their steps with workflows.list_step_runs. If refused, explain the refusal in a plain sentence.",
      inputSchema: z.object({ runId }),
      execute
    }),
    defineTool({
      ...presentation,
      name: "workflows.list_step_runs",
      title: { en: "Read Workflow step results", de: "Workflow-Schrittergebnisse lesen" },
      effect: "reading",
      description:
        "Read a page of a historical or test Workflow Run's steps in order, with status, target, error, start and finish times and permitted input/result previews. Match the run error's stepRunId to a step's id to explain its failure. Calculate each step's elapsed duration from startedAt and finishedAt where both are present. Target dry_run means Simulated: outputPreview says what it wouldHaveDone. Follow nextCursor until no page remains, steps in loops and blocks included. If refused, explain the refusal in a plain sentence.",
      inputSchema: z.object({
        runId,
        ...paging
      }),
      execute
    })
  ];
}
