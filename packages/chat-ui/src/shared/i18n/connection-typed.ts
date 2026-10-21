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
      "The operator's network rule blocks {service}. Ask the operator to allow it.",
    "connectionTyped.saved":
      "{name} is saved already and is in the list. Correct the field and connect again."
  },
  de: {
    "connectionTyped.heading": "{title} verbinden",
    "connectionTyped.stepService": "{service} erreicht",
    "connectionTyped.errorRefused":
      "{service} hat diese Zugangsdaten abgelehnt. Prüfe sie, gib das Secret erneut ein und verbinde noch einmal.",
    "connectionTyped.errorUnavailable":
      "{service} hat nicht wie erwartet geantwortet. Prüfe die Felder und verbinde noch einmal.",
    "connectionTyped.errorEgress":
      "Die Netzwerkregel des Betreibers sperrt {service}. Bitte den Betreiber, es freizugeben.",
    "connectionTyped.saved":
      "{name} ist schon gespeichert und steht in der Liste. Korrigiere das Feld und verbinde noch einmal."
  }
});
