import { defineTranslations } from "./translation-area";

// The New connection dialog for a Connector type with a form of its own, such as a document
// source. `{service}` is the type's service, such as Box.
export const connectionTyped = defineTranslations({
  en: {
    "connectionTyped.heading": "Connect {title}",
    "connectionTyped.stepService": "{service} reached",
    "connectionTyped.errorRefused":
      "{service} refused these credentials. Check them, enter the secret again and connect again.",
    "connectionTyped.errorUnavailable":
      "{service} did not answer as expected. Check the fields and connect again.",
    "connectionTyped.errorEgress":
      "A network rule blocks {service}. Ask the technical team to allow it.",
    "connectionTyped.saved":
      "{name} is saved already and is in the list. Correct the field and connect again.",
    "connectionTyped.connected": "{name} is connected.",
    "connectionTyped.reviewIntro": "None of its tools is enabled until you approve them.",
    "connectionTyped.whoUses": "Who may use it is set under use rights on its page.",
    "connectionTyped.whoUsesLink": "Choose who may use it"
  },
  de: {
    "connectionTyped.heading": "{title} verbinden",
    "connectionTyped.stepService": "{service} erreicht",
    "connectionTyped.errorRefused":
      "{service} hat diese Zugangsdaten abgelehnt. Prüfe sie, gib das Secret erneut ein und verbinde noch einmal.",
    "connectionTyped.errorUnavailable":
      "{service} hat nicht wie erwartet geantwortet. Prüfe die Felder und verbinde noch einmal.",
    "connectionTyped.errorEgress":
      "Eine Netzwerkregel sperrt {service}. Bitte das technische Team, es freizugeben.",
    "connectionTyped.saved":
      "{name} ist schon gespeichert und steht in der Liste. Korrigiere das Feld und verbinde noch einmal.",
    "connectionTyped.connected": "{name} ist verbunden.",
    "connectionTyped.reviewIntro": "Keines seiner Tools ist eingeschaltet, bevor du es freigibst.",
    "connectionTyped.whoUses":
      "Wer sie nutzen darf, legst du auf ihrer Seite unter Nutzungsrechten fest.",
    "connectionTyped.whoUsesLink": "Festlegen, wer sie nutzen darf"
  }
});
