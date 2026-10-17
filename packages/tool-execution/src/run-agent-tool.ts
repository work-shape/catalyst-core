import {
  RUN_AGENT_TOOL_NAME,
  SUBAGENTS_PER_RUN,
  SUBAGENTS_PER_STEP,
  SUBAGENT_DESCRIPTION_MAX_LENGTH,
  SUBAGENT_TASK_MAX_LENGTH
} from "@work-shape/catalyst-core";
import { defineTool, toolFailed, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/**
 * The input of `run_agent` and of the operation `agents.run` it is (CR-1). `background` and
 * `continueRunId` are reserved for later releases and refused now, as is any other field.
 */
export const runAgentInputSchema = z.strictObject(
  {
    description: z
      .string()
      .trim()
      .min(1)
      .max(SUBAGENT_DESCRIPTION_MAX_LENGTH)
      .describe(
        `A few words that name the sub-task, at most ${SUBAGENT_DESCRIPTION_MAX_LENGTH} characters. The person reads it on the subagent's card.`
      ),
    task: z
      .string()
      .trim()
      .min(1)
      .max(SUBAGENT_TASK_MAX_LENGTH)
      .describe(
        "Everything the subagent needs to do the sub-task: it does not see this conversation. Say what to find out or make, what to answer with, and the facts, names and files it needs."
      ),
    agent: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "The agent to run. Leave it out to run yourself in a fresh context, with your own model and tools."
      )
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `run_agent takes description, task and agent only; ${issue.keys.join(", ")} ${issue.keys.length === 1 ? "is" : "are"} not supported`
        : undefined
  }
);

export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

/**
 * The output of `agents.run`: the child it started, the agent it is and its description. Its
 * answer comes when the step ends.
 */
export const runAgentOutputSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  agent: z.string(),
  description: z.string()
});

/**
 * The tool `run_agent` as the model reads it. The tool runner calls the operation `agents.run`
 * for it, so the agent's list, the person's rights and the policy decide as for any call; this
 * definition only describes the call and is never executed itself.
 */
export function createRunAgentTool(): AnyToolDefinition {
  return defineTool({
    name: RUN_AGENT_TOOL_NAME,
    title: { en: "Run a subagent", de: "Subagenten starten" },
    summary: {
      en: "Hands a sub-task to a subagent that works in a thread of its own.",
      de: "Übergibt eine Teilaufgabe an einen Subagenten, der in einem eigenen Verlauf arbeitet."
    },
    group: "platform",
    icon: "agent",
    effect: "changing",
    permission: { mode: "allow" },
    description: [
      "Start a subagent: an agent that works on one sub-task in a thread of its own and answers you when it is done.",
      "Use it for independent parts of a larger task, such as researching several subjects. Start all of them in the same step: they run at the same time, and you get every answer as the result of its call once the last one has ended.",
      "The subagent does not see this conversation, so the task must hold everything it needs. It acts for the same person, with the same rights, and its files land in this conversation.",
      "A subagent cannot ask the person to confirm a call; where it needed one, its answer says so, and you make that call yourself.",
      `At most ${SUBAGENTS_PER_STEP} subagents in one step and ${SUBAGENTS_PER_RUN} in one run. A subagent cannot start subagents of its own.`
    ].join(" "),
    inputSchema: runAgentInputSchema,
    outputSchema: runAgentOutputSchema,
    execute: () => toolFailed("handler_failed", "Call run_agent through the operation runner")
  });
}
