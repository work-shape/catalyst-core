// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/mail-sender.ts` names.
export const accessMailSender = defineTranslations({
  en: {
    "access.scopeMailSender": "Sender {name}",
    "access.scopeOnMailSender": "On one sender",
    "access.scopeOnMailSenderDescription": "The sender system: the built-in mailer.",
    "access.grantMailSender": "Sender",
    "access.chooseMailSender": "Choose a sender",
    "access.noMailSenders": "E-mail sending is not enabled.",
    "access.mailSendersLoadFailed": "The senders could not be loaded.",
    "access.kindMailSender": "E-mail senders",
    "access.objectMailSender": "the sender {name}"
  },
  de: {
    "access.scopeMailSender": "Absender {name}",
    "access.scopeOnMailSender": "An einem Absender",
    "access.scopeOnMailSenderDescription": "Der Absender system: der eingebaute Mailer.",
    "access.grantMailSender": "Absender",
    "access.chooseMailSender": "Absender wählen",
    "access.noMailSenders": "Der E-Mail-Versand ist nicht eingeschaltet.",
    "access.mailSendersLoadFailed": "Die Absender konnten nicht geladen werden.",
    "access.kindMailSender": "E-Mail-Absender",
    "access.objectMailSender": "den Absender {name}"
  }
});
