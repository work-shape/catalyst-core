import {
  RUN_AGENT_LISTED_AGENTS_MAX,
  RUN_AGENT_TOOL_NAME,
  SUBAGENTS_PER_RUN,
  SUBAGENTS_PER_STEP,
  SUBAGENT_DESCRIPTION_MAX_LENGTH,
  SUBAGENT_TASK_MAX_LENGTH,
  type SubagentChoices,
  type ToolDescriptor
} from "@work-shape/catalyst-core";
import {
  defineTool,
  deriveInputJsonSchema,
  toolFailed,
  type AnyToolDefinition
} from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

const descriptionField = z
  .string()
  .trim()
  .min(1)
  .max(SUBAGENT_DESCRIPTION_MAX_LENGTH)
  .describe(
    `A few words that name the sub-task, at most ${SUBAGENT_DESCRIPTION_MAX_LENGTH} characters. The person reads it on the subagent's card.`
  );

const taskField = z
  .string()
  .trim()
  .min(1)
  .max(SUBAGENT_TASK_MAX_LENGTH)
  .describe(
    "Everything the subagent needs to do the sub-task: it does not see this conversation. Say what to find out or make, what to answer with, and the facts, names and files it needs."
  );

const AGENT_FIELD = "The agent to run. Leave it out to run yourself in a fresh context.";
const MODEL_FIELD =
  "The model the subagent runs on. Leave it out and a copy of yourself runs on your model and effort, another agent on its own default model; pick a smaller one for mechanical work.";

/**
 * The input of `run_agent` and of the operation `agents.run` it is (CR-1, CR-3m). `agent` and
 * `model` are any text here: a run's model is shown them as lists of what it may name
 * (`describeRunAgentTool`), and the call checks the name against the rights of now. The
 * reserved `background` and `continueRunId` are refused, as is any other field.
 */
export const runAgentInputSchema = z.strictObject(
  {
    description: descriptionField,
    task: taskField,
    agent: z.string().trim().min(1).optional().describe(AGENT_FIELD),
    model: z.string().trim().min(1).optional().describe(MODEL_FIELD)
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `run_agent takes description, task, agent and model only; ${issue.keys.join(", ")} ${issue.keys.length === 1 ? "is" : "are"} not supported`
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

const RUN_AGENT_DESCRIPTION = [
  "Start a subagent: an agent that works on one sub-task in a thread of its own and answers you when it is done.",
  "Use it for independent parts of a larger task, such as researching several subjects. Start all of them in the same step: they run at the same time, and you get every answer as the result of its call once the last one has ended.",
  "The subagent does not see this conversation, so the task must hold everything it needs. It acts for the same person, with the same rights, and its files land in this conversation.",
  "A subagent cannot ask the person to confirm a call; where it needed one, its answer names the exact operation and arguments that still need to be called. Make that call yourself so the person can confirm it. Keep operation ids out of your reply to the person.",
  `At most ${SUBAGENTS_PER_STEP} subagents in one step and ${SUBAGENTS_PER_RUN} in one run. A subagent cannot start subagents of its own.`
].join(" ");

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
    description: RUN_AGENT_DESCRIPTION,
    inputSchema: runAgentInputSchema,
    outputSchema: runAgentOutputSchema,
    execute: () => toolFailed("handler_failed", "Call run_agent through the operation runner")
  });
}

/**
 * `run_agent` as one run's model reads it (CR-3m): the agents and models it may name, from
 * live config and its person's rights, as enums with one line per value. The choices come
 * sorted, so the same config and rights give the same definition and a provider's prompt
 * cache holds. A property with nothing to name is left out.
 */
export function describeRunAgentTool(choices: SubagentChoices): ToolDescriptor {
  const agentLines = choices.agents.map((agent) =>
    [
      `- ${agent.name}: ${agent.displayName}`,
      agent.name === choices.ownAgentName ? " (yourself)" : "",
      agent.description ? ` — ${agent.description}` : "",
      agent.modelBindingIds.length > 0 ? ` (models: ${agent.modelBindingIds.join(", ")})` : ""
    ].join("")
  );
  const modelLines = choices.models.map((model) =>
    [
      `- ${model.bindingId}: ${model.label}`,
      model.description ? ` — ${model.description}` : "",
      model.usageTier ? ` (usage: ${model.usageTier})` : ""
    ].join("")
  );
  const [firstAgent, ...otherAgents] = choices.agents.map((agent) => agent.name);
  const [firstModel, ...otherModels] = choices.models.map((model) => model.bindingId);
  const schema = z.strictObject({
    description: descriptionField,
    task: taskField,
    ...(firstAgent === undefined
      ? {}
      : {
          agent: z
            .enum([firstAgent, ...otherAgents])
            .optional()
            .describe(
              [
                AGENT_FIELD,
                ...agentLines,
                ...(choices.moreAgents
                  ? [
                      `More than ${RUN_AGENT_LISTED_AGENTS_MAX} agents are available; these are the first.`
                    ]
                  : [])
              ].join("\n")
            )
        }),
    ...(firstModel === undefined
      ? {}
      : {
          model: z
            .enum([firstModel, ...otherModels])
            .optional()
            .describe(
              [`${MODEL_FIELD} An agent takes only the models its line names.`, ...modelLines].join(
                "\n"
              )
            )
        })
  });
  return {
    name: RUN_AGENT_TOOL_NAME,
    description: RUN_AGENT_DESCRIPTION,
    inputJsonSchema: deriveInputJsonSchema(schema)
  };
}
