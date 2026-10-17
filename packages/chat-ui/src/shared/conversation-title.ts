import type { TranslationContextValue } from "./i18n";

/**
 * The title a conversation is stored with until it has a first line. The server writes the same
 * words and replaces exactly these with a generated title, so the interface sends them in every
 * language and translates them only where a title is shown.
 */
export const NEW_CONVERSATION_TITLE = "New conversation";

/** The title people read for a conversation: its own, or the placeholder in their language. */
export function conversationTitle(title: string, t: TranslationContextValue["t"]): string {
  return title === NEW_CONVERSATION_TITLE ? t("conversationNewTitle") : title;
}
