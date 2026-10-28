import { defineTranslations } from "./translation-area";

/** The agent's question to the person in the conversation (ASK-1): its card and its answer. */
export const questions = defineTranslations({
  en: {
    "questions.recommended": "Recommended",
    "questions.own": "Or your own answer",
    "questions.send": "Answer",
    "questions.answered": "Your answer",
    "questions.failed": "The answer could not be sent. Try again."
  },
  de: {
    "questions.recommended": "Empfohlen",
    "questions.own": "Oder eigene Antwort",
    "questions.send": "Antworten",
    "questions.answered": "Deine Antwort",
    "questions.failed": "Die Antwort konnte nicht gesendet werden. Versuch es noch einmal."
  }
});
