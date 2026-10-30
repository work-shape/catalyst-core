import type { TranslationKey } from "../../shared/i18n";

/**
 * The default rules on chat input (GR-4) in the reader's language. The operator's floor names them
 * in English; where an operator wrote a rule of the same name, its own words stand, as its title
 * then differs from the default's.
 */
export const CHAT_INPUT_RULE_WORDS: Readonly<
  Record<string, { defaultTitle: string; title: TranslationKey; reason: TranslationKey }>
> = {
  "chat-secrets": {
    defaultTitle: "Secrets in chat",
    title: "chatInput.rule.secretsTitle",
    reason: "chatInput.rule.secretsReason"
  },
  "chat-passwords": {
    defaultTitle: "Passwords in chat",
    title: "chatInput.rule.passwordsTitle",
    reason: "chatInput.rule.passwordsReason"
  },
  "chat-card-numbers": {
    defaultTitle: "Card numbers in chat",
    title: "chatInput.rule.cardNumbersTitle",
    reason: "chatInput.rule.cardNumbersReason"
  },
  "chat-special-categories": {
    defaultTitle: "Special categories of personal data in chat",
    title: "chatInput.rule.specialCategoriesTitle",
    reason: "chatInput.rule.specialCategoriesReason"
  }
};

/** The words of a default rule on chat input, where the answer is one as shipped. */
export function chatInputRuleWords(answer: {
  origin: string;
  name: string;
  title: string;
}): { title: TranslationKey; reason: TranslationKey } | undefined {
  if (answer.origin !== "release") return undefined;
  const words = CHAT_INPUT_RULE_WORDS[answer.name];
  return words && words.defaultTitle === answer.title ? words : undefined;
}
