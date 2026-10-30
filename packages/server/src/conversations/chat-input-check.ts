import type {
  ChatInputCheckView,
  ChatInputRefusalDetails
} from "@work-shape/catalyst-api-contract";
import {
  AppError,
  CHAT_INPUT_EVENT,
  guardrailAnswerRef,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type ConversationId,
  type DraftAttachment,
  type GuardrailAnswer,
  type GuardrailFields,
  type MessageId
} from "@work-shape/catalyst-core";
import { GUARDRAIL_CHECKED_FIELD_MAX_CHARS } from "@work-shape/catalyst-config-schema";
import type { ChatServerOptions } from "../types";

// The guardrails on a person's chat message (GR-4): `message.before_send` on the text and on the
// text of its attachments, before the message is stored or any model reads it. Only patterns
// run here, inside the instance. A block refuses the message, which is not stored and stays in
// the composer; a warning refuses it until the person sends it anyway. Hits keep the rule, the
// message id, the field and a count. Nothing of the text is kept, logged, audited or sent
// anywhere: the errors and answers name guardrails and files, never what matched.
// Spec: events-workflows-and-guardrails.md, Guardrails on chat.

type Options = Pick<ChatServerOptions, "attachments" | "operationCalls">;

/**
 * Attachments whose text is read as it is, by their format. Every other file's text is not
 * extracted when it is sent, and the person is told it was not checked.
 */
const TEXT_FORMATS = new Set(["txt", "markdown", "csv", "json", "html", "xml", "css", "js", "svg"]);
const IMAGE_FORMATS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** The most bytes of one attachment that are read for the check: larger ones are not checked. */
const ATTACHMENT_TEXT_MAX_BYTES = GUARDRAIL_CHECKED_FIELD_MAX_CHARS;

export interface ChatInputCheckInput {
  /** Absent for the first message of a conversation not created yet, which has no files. */
  conversationId?: ConversationId;
  /** The id the message is stored under: the hits name it. A blocked one is never stored. */
  messageId: MessageId;
  text: string;
  attachments: readonly DraftAttachment[];
  agentName: string;
  workspaceId?: CollaborationWorkspaceId;
  user: AuthenticatedUser;
  correlationId: string;
  /** The person saw the warnings and sends anyway. A block still refuses. */
  acceptWarnings: boolean;
}

/**
 * Checks a chat message. Throws `GUARDRAIL_BLOCKED` where a guardrail blocks, and `CONFLICT`
 * where one warns and the person did not accept the warnings. Answers what the person is told
 * beside the message: the warnings they accepted and what was not checked.
 */
export async function checkChatInput(
  options: Options,
  input: ChatInputCheckInput
): Promise<ChatInputCheckView | undefined> {
  const events = options.operationCalls?.deps.events;
  if (!events) return undefined;
  const read = await readAttachmentTexts(options, input);
  const answer = await events.emit(
    CHAT_INPUT_EVENT,
    input.conversationId ? { conversationId: input.conversationId } : {},
    {
      actor: input.user,
      origin: { kind: "user" },
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      correlationId: input.correlationId,
      subject: { kind: "message", id: input.messageId },
      phase: "before",
      filterBy: { agent: input.agentName },
      checkable: (): GuardrailFields => ({
        text: input.text,
        ...(read.texts.length > 0 ? { attachments: read.texts.join("\n") } : {})
      }),
      // Asked again after the person accepted the warnings: those hits were kept already.
      ...(input.acceptWarnings ? { repeated: true as const } : {})
    }
  );
  const notChecked = notCheckedOf(answer.guardrails, read);
  const stopping = answer.guardrails.filter((entry) => entry.outcome !== "allow");
  const refs = stopping.flatMap((entry) => {
    const ref = guardrailAnswerRef(entry);
    return ref ? [ref] : [];
  });
  if (answer.outcome === "block" || answer.outcome === "require_approval") {
    const blocking = stopping.filter((entry) => entry.outcome !== "warn");
    const details: ChatInputRefusalDetails = {
      reason: "chat_input_blocked",
      guardrails: refs,
      ...notChecked
    };
    throw new AppError(
      "GUARDRAIL_BLOCKED",
      blockedMessage(blocking),
      {
        ...details,
        // The first that blocked, as every other guardrail refusal names it (GR-3).
        ...(blocking[0] ? { guardrailId: blocking[0].guardrailName } : {}),
        ...(blocking[0] && guardrailAnswerRef(blocking[0])
          ? { guardrail: guardrailAnswerRef(blocking[0]) }
          : {})
      },
      { exposeMessage: true }
    );
  }
  if (answer.outcome === "warn" && !input.acceptWarnings) {
    const details: ChatInputRefusalDetails = {
      reason: "chat_input_warning",
      guardrails: refs,
      ...notChecked
    };
    throw new AppError(
      "CONFLICT",
      "A guardrail warns about this message. Nothing was sent; send it anyway to go on.",
      details,
      { exposeMessage: true }
    );
  }
  const view: ChatInputCheckView = {
    ...(refs.length > 0 ? { guardrails: refs } : {}),
    ...notChecked
  };
  return Object.keys(view).length > 0 ? view : undefined;
}

function blockedMessage(blocking: readonly GuardrailAnswer[]): string {
  const [first] = blocking;
  if (!first) return "A guardrail blocked this message. Nothing was sent or stored.";
  return first.unavailable
    ? "The checks of this message could not run, so it was not sent. Try again later."
    : `The guardrail '${first.displayName}' blocked this message. Nothing was sent or stored.`;
}

interface ReadAttachments {
  /** The text of each attachment that was read, in order. */
  texts: string[];
  /** The attachments whose text was read. */
  read: { attachmentId: string; filename: string }[];
  notChecked: NonNullable<ChatInputCheckView["attachmentsNotChecked"]>;
}

/**
 * The text of the message's attachments as far as it can be read when it is sent: a text file
 * as it is, up to the size a check reads. A picture, a document whose text is extracted later
 * and anything that cannot be read are not checked, and the answer says which.
 */
async function readAttachmentTexts(
  options: Options,
  input: Pick<ChatInputCheckInput, "attachments" | "conversationId">
): Promise<ReadAttachments> {
  const result: ReadAttachments = { texts: [], read: [], notChecked: [] };
  const { conversationId } = input;
  if (!conversationId) return result;
  for (const attachment of input.attachments) {
    const format = (attachment.format ?? formatOfMimeType(attachment.mimeType))?.toLowerCase();
    const named = { attachmentId: String(attachment.id), filename: attachment.filename };
    if (format !== undefined && IMAGE_FORMATS.has(format)) {
      result.notChecked.push({ ...named, cause: "image" });
      continue;
    }
    if (format === undefined || !TEXT_FORMATS.has(format)) {
      result.notChecked.push({ ...named, cause: "not_extracted" });
      continue;
    }
    if (attachment.byteSize > ATTACHMENT_TEXT_MAX_BYTES) {
      result.notChecked.push({ ...named, cause: "too_large" });
      continue;
    }
    try {
      const file = await options.attachments?.readConversationFile({
        conversationId,
        fileId: String(attachment.fileId)
      });
      if (!file) {
        result.notChecked.push({ ...named, cause: "unreadable" });
        continue;
      }
      result.texts.push(new TextDecoder("utf-8").decode(file.bytes));
      result.read.push(named);
    } catch {
      // Why it could not be read is not said: the error may name the file's place in storage.
      result.notChecked.push({ ...named, cause: "unreadable" });
    }
  }
  return result;
}

function formatOfMimeType(mimeType: string | undefined): string | undefined {
  const type = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!type) return undefined;
  if (type === "text/plain") return "txt";
  if (type === "text/markdown") return "markdown";
  if (type === "text/csv") return "csv";
  if (type === "application/json") return "json";
  if (type.startsWith("image/")) return type.slice("image/".length);
  return undefined;
}

/**
 * What the person is told was not checked: the files that could not be read, and the fields a
 * rule could not read whole, such as a text longer than its pattern reads.
 */
function notCheckedOf(
  answers: readonly GuardrailAnswer[],
  read: ReadAttachments
): Pick<ChatInputCheckView, "textNotChecked" | "attachmentsNotChecked"> {
  const fields = new Set(answers.flatMap((answer) => answer.notChecked ?? []));
  const attachments = [
    ...read.notChecked,
    ...(fields.has("attachments")
      ? read.read.map((entry) => ({ ...entry, cause: "too_large" as const }))
      : [])
  ];
  return {
    ...(fields.has("text") ? { textNotChecked: true as const } : {}),
    ...(attachments.length > 0 ? { attachmentsNotChecked: attachments } : {})
  };
}
