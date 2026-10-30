import { defineTranslations } from "./translation-area";

/**
 * A guardrail's answer where the person acts, and the read-only Rules in force page (GR-3).
 */
export const guardrailAnswers = defineTranslations({
  en: {
    "settings.rulesInForce": "Rules in force",
    "rulesInForce.description":
      "The guardrails that apply to you: those the operator sets, those the platform ships and those published for all workspaces or for your workspaces. A guardrail checks an action before it happens and warns, holds it for approval or blocks it.",
    "rulesInForce.floor": "Set by the operator",
    "rulesInForce.floorDescription": "Part of the system setup. Nobody here can change them.",
    "rulesInForce.instance": "All workspaces",
    "rulesInForce.workspace": "Workspace {name}",
    "rulesInForce.someWorkspace": "A workspace",
    "rulesInForce.empty": "No guardrails apply to you.",
    "rulesInForce.loadFailed": "The rules in force could not be loaded.",
    "rulesInForce.off": "Switched off",
    "rulesInForce.hits": "{count} times in the last 30 days",
    "rulesInForce.noHits": "Not in the last 30 days",
    "rulesInForce.ask": "Ask",
    "guardrailAnswer.title": "Guardrail “{title}”",
    "guardrailAnswer.label": "Guardrail answer: {title}",
    "guardrailAnswer.scopeInstance": "All workspaces",
    "guardrailAnswer.scopeWorkspace": "Workspace {name}",
    "guardrailAnswer.scopeSomeWorkspace": "One workspace",
    "guardrailAnswer.revision": "Version {revision}",
    "guardrailAnswer.setByOperator": "Set by the operator. Nobody here can change it.",
    "guardrailAnswer.publishedBy": "Version {revision} published by {name}, {when}.",
    "guardrailAnswer.publishedByHidden": "Version {revision} published {when}.",
    "guardrailAnswer.switchedBy": "Last switched by {name}, {when}.",
    "guardrailAnswer.asShipped": "As the platform ships it.",
    "guardrailAnswer.changers": "Who can change it: {names}.",
    "guardrailAnswer.changersMore": "Who can change it: {names} and {count} more.",
    "guardrailAnswer.changersAdmin": "An admin for all workspaces can change it, such as {name}.",
    "guardrailAnswer.changersUnnamed":
      "Whoever may publish guardrails for its scope can change it.",
    "guardrailAnswer.approvalAsked":
      "An approval was asked for. The action goes ahead once someone who may approve it agrees.",
    "guardrailAnswer.approvalCannotWait":
      "It needs an approval, and this action cannot wait for one. Ask who can change it, or try again where an approval can be waited for.",
    "guardrailAnswer.ask": "Ask about it",
    "guardrailAnswer.askLabel": "Your question",
    "guardrailAnswer.askHint":
      "It goes to the Inbox of the people who can change this guardrail, with your name.",
    "guardrailAnswer.askSend": "Send question",
    "guardrailAnswer.askCancel": "Cancel",
    "guardrailAnswer.asked": "Your question is in the Inbox of {count} people.",
    "guardrailAnswer.askedOne": "Your question is in the Inbox of the person who can change it.",
    "guardrailAnswer.askFailed": "Your question was not sent.",
    "guardrailAnswer.rulesLink": "Rules in force"
  },
  de: {
    "settings.rulesInForce": "Geltende Regeln",
    "rulesInForce.description":
      "Die Leitplanken, die für dich gelten: vom Betreiber festgelegte, von der Plattform mitgelieferte und für alle Arbeitsbereiche oder deine Arbeitsbereiche veröffentlichte. Eine Leitplanke prüft eine Aktion, bevor sie passiert, und warnt, hält sie zur Freigabe an oder blockiert sie.",
    "rulesInForce.floor": "Vom Betreiber festgelegt",
    "rulesInForce.floorDescription": "Teil der Systemeinrichtung. Hier kann sie niemand ändern.",
    "rulesInForce.instance": "Alle Arbeitsbereiche",
    "rulesInForce.workspace": "Arbeitsbereich {name}",
    "rulesInForce.someWorkspace": "Ein Arbeitsbereich",
    "rulesInForce.empty": "Für dich gelten keine Leitplanken.",
    "rulesInForce.loadFailed": "Die geltenden Regeln konnten nicht geladen werden.",
    "rulesInForce.off": "Ausgeschaltet",
    "rulesInForce.hits": "{count}-mal in den letzten 30 Tagen",
    "rulesInForce.noHits": "Nicht in den letzten 30 Tagen",
    "rulesInForce.ask": "Nachfragen",
    "guardrailAnswer.title": "Leitplanke „{title}“",
    "guardrailAnswer.label": "Antwort einer Leitplanke: {title}",
    "guardrailAnswer.scopeInstance": "Alle Arbeitsbereiche",
    "guardrailAnswer.scopeWorkspace": "Arbeitsbereich {name}",
    "guardrailAnswer.scopeSomeWorkspace": "Ein Arbeitsbereich",
    "guardrailAnswer.revision": "Version {revision}",
    "guardrailAnswer.setByOperator": "Vom Betreiber festgelegt. Hier kann sie niemand ändern.",
    "guardrailAnswer.publishedBy": "Version {revision} veröffentlicht von {name}, {when}.",
    "guardrailAnswer.publishedByHidden": "Version {revision} veröffentlicht {when}.",
    "guardrailAnswer.switchedBy": "Zuletzt umgeschaltet von {name}, {when}.",
    "guardrailAnswer.asShipped": "So, wie die Plattform sie mitliefert.",
    "guardrailAnswer.changers": "Ändern können sie: {names}.",
    "guardrailAnswer.changersMore": "Ändern können sie: {names} und {count} weitere.",
    "guardrailAnswer.changersAdmin":
      "Ein Admin für alle Arbeitsbereiche kann sie ändern, etwa {name}.",
    "guardrailAnswer.changersUnnamed":
      "Ändern kann sie, wer für ihren Bereich Leitplanken veröffentlichen darf.",
    "guardrailAnswer.approvalAsked":
      "Eine Freigabe ist angefragt. Die Aktion läuft, sobald jemand, der sie freigeben darf, zustimmt.",
    "guardrailAnswer.approvalCannotWait":
      "Sie braucht eine Freigabe, und diese Aktion kann nicht darauf warten. Frag nach, wer sie ändern kann, oder versuch es dort, wo auf eine Freigabe gewartet werden kann.",
    "guardrailAnswer.ask": "Nachfragen",
    "guardrailAnswer.askLabel": "Deine Frage",
    "guardrailAnswer.askHint":
      "Sie geht mit deinem Namen in die Inbox der Personen, die diese Leitplanke ändern können.",
    "guardrailAnswer.askSend": "Frage senden",
    "guardrailAnswer.askCancel": "Abbrechen",
    "guardrailAnswer.asked": "Deine Frage ist in der Inbox von {count} Personen.",
    "guardrailAnswer.askedOne": "Deine Frage ist in der Inbox der Person, die sie ändern kann.",
    "guardrailAnswer.askFailed": "Deine Frage wurde nicht gesendet.",
    "guardrailAnswer.rulesLink": "Geltende Regeln"
  }
});
