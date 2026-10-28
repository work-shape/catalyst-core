import { ASK_QUESTION_TOOL_NAME } from "@work-shape/catalyst-core";
import { toolAnswer } from "../conversation/subject-run";

// The agent's question to the person (ASK-1). The tool answers the question as the card shows
// it; the run ends its turn after the step that asked. The person's next message is the answer,
// whether they picked an option on the card or typed in the composer, so a card is answered as
// soon as a message of the person follows it in the conversation, also after a reload.

export { ASK_QUESTION_TOOL_NAME };

export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** A question as its card reads it from the tool's answer. */
export interface AskedQuestion {
  question: string;
  options: QuestionOption[];
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The question the tool answered, or nothing for an answer that is none, such as a refusal. */
export function readAskedQuestion(result: unknown): AskedQuestion | undefined {
  const answer = toolAnswer(result);
  const question = textOf(answer?.question);
  const listed = answer?.options;
  if (question === undefined || !Array.isArray(listed)) return undefined;
  const options = listed.flatMap((entry: unknown): QuestionOption[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const label = textOf("label" in entry ? entry.label : undefined);
    if (label === undefined) return [];
    const description = textOf("description" in entry ? entry.description : undefined);
    const recommended = "recommended" in entry && entry.recommended === true;
    return [
      {
        label,
        ...(description === undefined ? {} : { description }),
        ...(recommended ? { recommended: true } : {})
      }
    ];
  });
  if (options.length === 0) return undefined;
  // The recommended option first, as the tool answers it.
  return {
    question,
    options: [
      ...options.filter((option) => option.recommended === true),
      ...options.filter((option) => option.recommended !== true)
    ]
  };
}

/** A call whose card is the agent's question. */
export function isQuestionCall(part: {
  type: string;
  toolName?: string;
  result?: unknown;
}): boolean {
  return (
    part.type === "tool-call" &&
    part.toolName === ASK_QUESTION_TOOL_NAME &&
    readAskedQuestion(part.result) !== undefined
  );
}

/** One message of the thread, as far as the answers read it. */
export interface QuestionThreadMessage {
  role: string;
  parts: readonly { type: string; text?: string; toolCallId?: string; toolName?: string }[];
}

/** No question of the thread is answered. */
export const NO_QUESTION_ANSWERS: ReadonlyMap<string, string> = new Map();

/**
 * The answer to each question of the thread, by call id: the text of the person's first message
 * after the message that asked. A question no message follows yet is open.
 */
export function questionAnswers(
  messages: readonly QuestionThreadMessage[]
): ReadonlyMap<string, string> {
  const answers = new Map<string, string>();
  let open: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (open.length === 0) continue;
      const text = message.parts
        .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
        .join("\n")
        .trim();
      for (const callId of open) answers.set(callId, text);
      open = [];
      continue;
    }
    for (const part of message.parts) {
      if (
        part.type === "tool-call" &&
        part.toolName === ASK_QUESTION_TOOL_NAME &&
        part.toolCallId
      ) {
        open.push(part.toolCallId);
      }
    }
  }
  return answers;
}
