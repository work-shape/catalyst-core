import {
  ASK_QUESTION_TOOL_NAME,
  QUESTION_MAX_LENGTH,
  QUESTION_OPTION_DESCRIPTION_MAX_LENGTH,
  QUESTION_OPTION_LABEL_MAX_LENGTH,
  QUESTION_OPTIONS_MAX,
  QUESTION_OPTIONS_MIN
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

// A question to the person (ASK-1): the chat shows the question and its options as a card, and
// the run ends its turn after the step that asked. The person's choice, or what they type, is
// their next message. The tool reads nothing of the instance and changes nothing: it answers
// the question as the card shows it, the recommended option first.

const optionSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(QUESTION_OPTION_LABEL_MAX_LENGTH)
    .describe(
      "The answer in a few everyday words, as the person would say it. It is sent as their message when they pick it."
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(QUESTION_OPTION_DESCRIPTION_MAX_LENGTH)
    .optional()
    .describe(
      "A few plain words on what this answer means for the person; for the recommended answer, why you recommend it. Leave it out where the label says it."
    ),
  recommended: z
    .boolean()
    .optional()
    .describe("True for the one option you recommend. At most one option.")
});

const inputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(QUESTION_MAX_LENGTH)
    .describe("One question about the outcome, in everyday words and in the person's language."),
  options: z
    .array(optionSchema)
    .min(QUESTION_OPTIONS_MIN)
    .max(QUESTION_OPTIONS_MAX)
    .refine((options) => options.filter((option) => option.recommended === true).length <= 1, {
      message: "Mark at most one option as recommended"
    })
    .refine(
      (options) =>
        new Set(options.map((option) => option.label.toLocaleLowerCase())).size === options.length,
      { message: "Each option needs a label of its own" }
    )
    .describe(
      `${QUESTION_OPTIONS_MIN} to ${QUESTION_OPTIONS_MAX} short, concrete answers that differ in what the person gets. The person can always type an answer of their own, so no "Other" option.`
    )
});

const outputSchema = z.object({
  question: z.string(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string().optional(),
      recommended: z.boolean().optional()
    })
  )
});

export type AskedQuestion = z.infer<typeof outputSchema>;

/** The tool that asks the person one question, as a card in the conversation. */
export function createAskQuestionTool(): AnyToolDefinition {
  return defineTool({
    name: ASK_QUESTION_TOOL_NAME,
    title: { en: "Ask a question", de: "Frage stellen" },
    summary: {
      en: "Asks the person one question with a few answers to pick from.",
      de: "Stellt der Person eine Frage mit einigen Antworten zur Auswahl."
    },
    group: "platform",
    icon: "prompt",
    effect: "reading",
    permission: { mode: "allow" },
    description: [
      "Ask the person one question with 2 to 4 answers to pick from; they can also type their own. The conversation shows it as a card and your turn ends after this step: call no other tool with it and write nothing after it. Their answer comes as their next message, and you go on from there.",
      "Ask only about outcomes the person cares about and cannot be read from the conversation: what they want to see, who should use it, or which of two behaviours they want. Ask before you build, not after, and ask whether to go on when a limit you found changes the result.",
      "Never ask about how it is built: storage, data stores, Workflows, Connections, APIs, file formats, names, layout details or defaults. Decide those yourself and mention them in one line when you hand over. Do not ask for permission to start work the person asked for. One question at a time.",
      "Write the question and the answers in everyday words, as a colleague would ask, short and concrete. Before the call, say in one sentence why you ask. Mark the answer you recommend, and say why in a few words in its line.",
      'Example: question "Who should be able to use the overview?", answers "Only me" (recommended: "you can share it later") and "My whole team".'
    ].join(" "),
    inputSchema,
    outputSchema,
    execute(input) {
      // The recommended option first, the others in the order the agent gave them.
      const options = [
        ...input.options.filter((option) => option.recommended === true),
        ...input.options.filter((option) => option.recommended !== true)
      ].map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(option.recommended === true ? { recommended: true } : {})
      }));
      return toolSuccess(
        { question: input.question, options },
        {
          auditSummary: {
            action: ASK_QUESTION_TOOL_NAME,
            metadata: { options: options.length }
          }
        }
      );
    }
  });
}
