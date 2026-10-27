import { defineTranslations } from "./translation-area";

/** "Problem an Workshape melden": the action under a failed run and its dialog. */
export const platformReport = defineTranslations({
  en: {
    "platformReport.action": "Report problem to Workshape",
    "platformReport.title": "Report problem to Workshape",
    "platformReport.description":
      "This was a problem of the platform. Workshape looks into it when you report it.",
    "platformReport.whatIsSent": "Workshape receives",
    "platformReport.run": "Run",
    "platformReport.errorCode": "Error code",
    "platformReport.instance": "Instance",
    "platformReport.time": "Time",
    "platformReport.timeNow": "Time of the failure and of this report",
    "platformReport.notSent":
      "Not included: what was written in the conversation, its files and any logs.",
    "platformReport.noteLabel": "What were you doing? (optional)",
    "platformReport.noteHint": "Do not paste personal data or data of clients.",
    "platformReport.noteTooLong": "Keep it to {max} characters.",
    "platformReport.replyToMe": "Answer to me",
    "platformReport.replyToMeHint": "Workshape can reply to {email}.",
    "platformReport.send": "Send",
    "platformReport.sent": "Reported to Workshape",
    "platformReport.alreadyReported": "You reported this problem already.",
    "platformReport.rateLimited": "You sent several reports in the last hour. Try again later.",
    "platformReport.failed": "The report could not be sent. Try again later."
  },
  de: {
    "platformReport.action": "Problem an Workshape melden",
    "platformReport.title": "Problem an Workshape melden",
    "platformReport.description":
      "Das war ein Problem der Plattform. Wenn du es meldest, schaut Workshape es sich an.",
    "platformReport.whatIsSent": "Workshape bekommt",
    "platformReport.run": "Lauf",
    "platformReport.errorCode": "Fehlercode",
    "platformReport.instance": "Instanz",
    "platformReport.time": "Zeitpunkt",
    "platformReport.timeNow": "Zeitpunkt des Fehlers und dieser Meldung",
    "platformReport.notSent":
      "Nicht dabei: was in der Unterhaltung steht, ihre Dateien und Protokolle.",
    "platformReport.noteLabel": "Was hast du gerade gemacht? (optional)",
    "platformReport.noteHint": "Füge keine personenbezogenen Daten und keine Daten von Kunden ein.",
    "platformReport.noteTooLong": "Höchstens {max} Zeichen.",
    "platformReport.replyToMe": "Antwort an mich",
    "platformReport.replyToMeHint": "Workshape kann dir an {email} antworten.",
    "platformReport.send": "Senden",
    "platformReport.sent": "An Workshape gemeldet",
    "platformReport.alreadyReported": "Du hast dieses Problem schon gemeldet.",
    "platformReport.rateLimited":
      "Du hast in der letzten Stunde schon mehrere Probleme gemeldet. Versuche es später erneut.",
    "platformReport.failed": "Die Meldung konnte nicht gesendet werden. Versuche es später erneut."
  }
});
