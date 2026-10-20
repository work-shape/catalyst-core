// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/mail-sender.ts` names.
export const accessMailSender = defineTranslations({
  en: {
    "access.scopeMailSender": "Sender {name}",
    "access.scopeOnMailSender": "On one sender",
    "access.scopeOnMailSenderDescription": "The sender system: the instance's own mailer.",
    "access.grantMailSender": "Sender",
    "access.chooseMailSender": "Choose a sender",
    "access.noMailSenders": "This instance sends no e-mail.",
    "access.mailSendersLoadFailed": "The senders could not be loaded.",
    "access.kindMailSender": "E-mail senders",
    "access.objectMailSender": "the sender {name}"
  },
  de: {
    "access.scopeMailSender": "Absender {name}",
    "access.scopeOnMailSender": "An einem Absender",
    "access.scopeOnMailSenderDescription": "Der Absender system: der Mailer der Instanz.",
    "access.grantMailSender": "Absender",
    "access.chooseMailSender": "Absender wählen",
    "access.noMailSenders": "Diese Instanz sendet keine E-Mails.",
    "access.mailSendersLoadFailed": "Die Absender konnten nicht geladen werden.",
    "access.kindMailSender": "E-Mail-Absender",
    "access.objectMailSender": "den Absender {name}"
  }
});
