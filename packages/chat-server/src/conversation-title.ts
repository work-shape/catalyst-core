import { type ChatMessage, type JsonObject, readUserMessageMetadata } from "@vivd-catalyst/core";
import type { ModelMessage } from "@vivd-catalyst/model-provider";

const MAX_TITLE_SOURCE_CHARS = 800;

export function createConversationTitle(text: string): string {
  return truncateConversationTitle(normalizeConversationTitle(text));
}

export function normalizeGeneratedConversationTitle(text: string): string {
  return truncateConversationTitle(
    normalizeConversationTitle(text)
      .replace(/^title:\s*/iu, "")
      .replace(/^["'`]+|["'`]+$/gu, "")
      .replace(/[.!?:;,-]+$/u, "")
  );
}

export function isTemporaryConversationTitle(
  title: string,
  firstUserText: string,
  additionalTemporaryTitles: readonly string[] = []
): boolean {
  const firstLine = firstUserText.split(/\r?\n/u)[0] ?? firstUserText;
  const temporaryTitles = new Set([
    "New conversation",
    createConversationTitle(firstUserText),
    createConversationTitle(firstLine),
    legacyFirstLineTitle(firstUserText)
  ]);

  for (const temporaryTitle of additionalTemporaryTitles) {
    temporaryTitles.add(temporaryTitle);
    temporaryTitles.add(createConversationTitle(temporaryTitle));
  }

  return temporaryTitles.has(title);
}

function normalizeConversationTitle(text: string): string {
  const normalized = text
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .replace(/[.!?]+$/u, "");
  if (!normalized) {
    return "New conversation";
  }
  return normalized;
}

function truncateConversationTitle(text: string): string {
  const firstLine = text.split(/\r?\n/u)[0]?.trim() ?? "";
  if (!firstLine) {
    return "New conversation";
  }
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}...` : firstLine;
}

function legacyFirstLineTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "New conversation";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || "New conversation";
}

export function findFirstUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((message) => message.role === "user");
}

export function temporaryAttachmentTitles(message: ChatMessage): string[] {
  const attachments = readAttachmentManifestEntries(message);
  if (attachments.length === 0) {
    return [];
  }

  const filenames = attachments
    .map((attachment) =>
      typeof attachment.filename === "string" ? attachment.filename : undefined
    )
    .filter((filename): filename is string => Boolean(filename));

  return [
    ...filenames,
    attachments.length === 1 ? "Attached file" : `${attachments.length} attached files`
  ];
}

function readAttachmentManifestEntries(message: ChatMessage): JsonObject[] {
  const runtime = readUserMessageMetadata(message.metadata);
  const manifest = runtime?.attachmentManifest;
  if (!isJsonObject(manifest) || manifest.version !== 1 || !Array.isArray(manifest.attachments)) {
    return [];
  }
  return manifest.attachments.filter(isJsonObject);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createTitlePrompt(firstUserMessage: ChatMessage): ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "Generate a short neutral headline/topic for a persisted conversation list.",
        "Infer the conversation topic from the initial user message only.",
        "The title should describe the overall likely conversation, not quote or answer the user message.",
        "Use 3 to 7 words.",
        "Do not include names, addresses, emails, phone numbers, bank details, exact salary amounts, IDs, or other personal data.",
        "If the content is sensitive, use a generic topic label.",
        "Return only the headline text."
      ].join(" ")
    },
    {
      role: "user",
      content: ["Initial user message:", truncateTitleSource(firstUserMessage.text)].join("\n")
    }
  ];
}

function truncateTitleSource(text: string): string {
  const normalized = text.split(/\s+/u).filter(Boolean).join(" ");
  return normalized.length > MAX_TITLE_SOURCE_CHARS
    ? `${normalized.slice(0, MAX_TITLE_SOURCE_CHARS).trimEnd()}...`
    : normalized;
}

export function isUsableGeneratedTitle(title: string): boolean {
  return title.length > 0 && title !== "New conversation";
}
