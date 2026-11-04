import { defineTranslations } from "./translation-area";

/** The guardrails on a chat message, as the composer shows them (GR-4). */
export const chatInputGuardrails = defineTranslations({
  en: {
    "chatInput.label": "Guardrails on this message",
    "chatInput.blocked":
      "Not sent. A guardrail stopped this message: nothing was sent or stored, and it is still in the field below.",
    "chatInput.warned":
      "Not sent yet. A guardrail warns about this message. Change it, or send it as it is.",
    "chatInput.unavailable":
      "Not sent. The checks of this message could not run. Try again in a moment.",
    "chatInput.sendAnyway": "Send anyway",
    "chatInput.rule.secretsTitle": "Secrets in chat",
    "chatInput.rule.secretsReason":
      "The message contains what looks like an API key, an access token or a private key. Remove it before you send the message, and change the secret if it was shared.",
    "chatInput.rule.passwordsTitle": "Passwords in chat",
    "chatInput.rule.passwordsReason":
      "The message seems to contain a password. Passwords do not belong in a chat; send it only if you are sure.",
    "chatInput.rule.cardNumbersTitle": "Card numbers in chat",
    "chatInput.rule.cardNumbersReason":
      "The message contains what looks like a payment card number. Send it only if the task needs it.",
    "chatInput.rule.specialCategoriesTitle": "Special categories of personal data in chat",
    "chatInput.rule.specialCategoriesReason":
      "The message may contain special categories of personal data, such as health, religion or union membership. Send it only if the task needs them.",
    "chatInput.hold.waiting": "The reply is being checked before it is shown.",
    "chatInput.hold.withheld": "The reply was withheld by the guardrail “{name}”.",
    "chatInput.hold.withheldReason": "Reason: {reason}"
  },
  de: {
    "chatInput.label": "Leitplanken zu dieser Nachricht",
    "chatInput.blocked":
      "Nicht gesendet. Eine Leitplanke hat diese Nachricht angehalten: Nichts wurde gesendet oder gespeichert, und sie steht weiter im Eingabefeld.",
    "chatInput.warned":
      "Noch nicht gesendet. Eine Leitplanke warnt vor dieser Nachricht. Ändere sie oder sende sie so, wie sie ist.",
    "chatInput.unavailable":
      "Nicht gesendet. Die Prüfungen dieser Nachricht konnten nicht laufen. Versuche es gleich noch einmal.",
    "chatInput.sendAnyway": "Trotzdem senden",
    "chatInput.rule.secretsTitle": "Geheimnisse im Chat",
    "chatInput.rule.secretsReason":
      "Die Nachricht enthält offenbar einen API-Schlüssel, ein Zugangstoken oder einen privaten Schlüssel. Entferne ihn vor dem Senden und ändere das Geheimnis, falls es schon geteilt wurde.",
    "chatInput.rule.passwordsTitle": "Passwörter im Chat",
    "chatInput.rule.passwordsReason":
      "Die Nachricht enthält offenbar ein Passwort. Passwörter gehören nicht in einen Chat; sende sie nur, wenn du dir sicher bist.",
    "chatInput.rule.cardNumbersTitle": "Kartennummern im Chat",
    "chatInput.rule.cardNumbersReason":
      "Die Nachricht enthält offenbar eine Zahlungskartennummer. Sende sie nur, wenn die Aufgabe sie braucht.",
    "chatInput.rule.specialCategoriesTitle": "Besonders geschützte Daten im Chat",
    "chatInput.rule.specialCategoriesReason":
      "Die Nachricht enthält vielleicht besonders geschützte personenbezogene Daten, etwa zu Gesundheit, Religion oder Gewerkschaftszugehörigkeit. Sende sie nur, wenn die Aufgabe sie braucht.",
    "chatInput.hold.waiting": "Die Antwort wird geprüft, bevor sie erscheint.",
    "chatInput.hold.withheld": "Die Antwort wurde von der Leitplanke „{name}“ zurückgehalten.",
    "chatInput.hold.withheldReason": "Grund: {reason}"
  }
});
