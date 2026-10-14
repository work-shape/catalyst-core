import { defineTranslations } from "./translation-area";

export const guardrails = defineTranslations({
  en: {
    "guardrails.kind": "Guardrails",
    "guardrails.description": "Guardrails come from the release config and cannot be changed here.",
    "guardrails.search": "Search guardrails",
    "guardrails.empty":
      "No guardrails yet. A guardrail checks an action before it happens and warns, holds it for approval or blocks it. The operator sets them in the release config.",
    "guardrails.missing": "There is no guardrail with the id {name}.",
    "guardrails.scopeInstance": "Instance",
    "guardrails.checkTitle": "Check",
    "guardrails.checkDescription":
      "What the guardrail checks, and what happens when it finds something.",
    "guardrails.when": "When",
    "guardrails.eventApprovalRequest": "Before a request for approval is filed",
    "guardrails.eventAssetWrite": "Before an asset is saved",
    "guardrails.eventOperationCall": "Before a tool or an operation is called",
    "guardrails.eventAppPublish": "Before an App is published",
    "guardrails.eventWorkflowPublish": "Before a Workflow is published",
    "guardrails.appliesTo": "Applies to",
    "guardrails.appliesToEvery": "Everything at this point",
    "guardrails.filterOperation": "Operation",
    "guardrails.filterOrigin": "Called from",
    "guardrails.filterAgent": "Agent",
    "guardrails.checkKind": "How it checks",
    "guardrails.checkModelJudge": "Model check",
    "guardrails.checkPattern": "Pattern",
    "guardrails.pattern": "Pattern",
    "guardrails.checkedFields": "Reads",
    "guardrails.onHit": "On a hit",
    "guardrails.outcomeAllow": "Allows",
    "guardrails.outcomeAllowText":
      "The action goes on. An allowing guardrail never lifts another one's warning or block.",
    "guardrails.outcomeWarn": "Warns",
    "guardrails.outcomeWarnText":
      "The action goes on with the reason, and whoever acts or decides on it sees the warning.",
    "guardrails.outcomeApproval": "Needs approval",
    "guardrails.outcomeApprovalText":
      "The action waits in the Inbox until somebody who may decide it approves it.",
    "guardrails.outcomeBlock": "Blocks",
    "guardrails.outcomeBlockText": "The action does not happen. Whoever acted is told the reason.",
    "guardrails.descriptionLabel": "Description",
    "guardrails.rule": "Rule",
    "guardrails.hitsTitle": "Recent hits",
    "guardrails.hitsDescription":
      "How often and when this guardrail warned, held or blocked, and on what, without naming anyone. Hits are kept as long as the audit log.",
    "guardrails.hitsEmpty": "No hits yet. Every warning, hold and block shows here.",
    "guardrails.hitsFailed": "The hits of this guardrail could not be loaded.",
    "guardrails.hitsMore": "Only the newest {count} hits are shown.",
    "guardrails.hitsLast7Days": "Last 7 days",
    "guardrails.hitsLast30Days": "Last 30 days",
    "guardrails.hitWarned": "Warned",
    "guardrails.hitHeld": "Held for approval",
    "guardrails.hitBlocked": "Blocked",
    "guardrails.hitUnevaluated": "The check could not be run.",
    "guardrails.subjectOperation": "Call of {name}"
  },
  de: {
    "guardrails.kind": "Leitplanken",
    "guardrails.description":
      "Leitplanken kommen aus der Release-Konfiguration und lassen sich hier nicht ändern.",
    "guardrails.search": "Leitplanken durchsuchen",
    "guardrails.empty":
      "Noch keine Leitplanken. Eine Leitplanke prüft eine Aktion, bevor sie geschieht, und warnt, hält sie zur Freigabe an oder blockiert sie. Der Betreiber legt sie in der Release-Konfiguration fest.",
    "guardrails.missing": "Es gibt keine Leitplanke mit der Kennung {name}.",
    "guardrails.scopeInstance": "Instanz",
    "guardrails.checkTitle": "Prüfung",
    "guardrails.checkDescription":
      "Was die Leitplanke prüft und was geschieht, wenn sie etwas findet.",
    "guardrails.when": "Wann",
    "guardrails.eventApprovalRequest": "Bevor eine Freigabe-Anfrage gestellt wird",
    "guardrails.eventAssetWrite": "Bevor ein Asset gespeichert wird",
    "guardrails.eventOperationCall": "Bevor ein Werkzeug oder eine Operation aufgerufen wird",
    "guardrails.eventAppPublish": "Bevor eine App veröffentlicht wird",
    "guardrails.eventWorkflowPublish": "Bevor ein Workflow veröffentlicht wird",
    "guardrails.appliesTo": "Gilt für",
    "guardrails.appliesToEvery": "Alles an dieser Stelle",
    "guardrails.filterOperation": "Operation",
    "guardrails.filterOrigin": "Aufgerufen aus",
    "guardrails.filterAgent": "Agent",
    "guardrails.checkKind": "Wie sie prüft",
    "guardrails.checkModelJudge": "Prüfung durch ein Modell",
    "guardrails.checkPattern": "Muster",
    "guardrails.pattern": "Muster",
    "guardrails.checkedFields": "Liest",
    "guardrails.onHit": "Bei einem Treffer",
    "guardrails.outcomeAllow": "Erlaubt",
    "guardrails.outcomeAllowText":
      "Die Aktion geht weiter. Eine erlaubende Leitplanke hebt die Warnung oder Blockade einer anderen nie auf.",
    "guardrails.outcomeWarn": "Warnt",
    "guardrails.outcomeWarnText":
      "Die Aktion geht mit der Begründung weiter, und wer handelt oder darüber entscheidet, sieht die Warnung.",
    "guardrails.outcomeApproval": "Braucht Freigabe",
    "guardrails.outcomeApprovalText":
      "Die Aktion wartet im Posteingang, bis jemand, der darüber entscheiden darf, sie freigibt.",
    "guardrails.outcomeBlock": "Blockiert",
    "guardrails.outcomeBlockText":
      "Die Aktion geschieht nicht. Wer gehandelt hat, erfährt die Begründung.",
    "guardrails.descriptionLabel": "Beschreibung",
    "guardrails.rule": "Regel",
    "guardrails.hitsTitle": "Letzte Treffer",
    "guardrails.hitsDescription":
      "Wie oft, wann und bei was diese Leitplanke gewarnt, angehalten oder blockiert hat, ohne Personen zu nennen. Treffer bleiben so lange wie das Audit-Protokoll.",
    "guardrails.hitsEmpty":
      "Noch keine Treffer. Jede Warnung, jedes Anhalten und jede Blockade erscheint hier.",
    "guardrails.hitsFailed": "Die Treffer dieser Leitplanke konnten nicht geladen werden.",
    "guardrails.hitsMore": "Nur die neuesten {count} Treffer werden gezeigt.",
    "guardrails.hitsLast7Days": "Letzte 7 Tage",
    "guardrails.hitsLast30Days": "Letzte 30 Tage",
    "guardrails.hitWarned": "Gewarnt",
    "guardrails.hitHeld": "Zur Freigabe angehalten",
    "guardrails.hitBlocked": "Blockiert",
    "guardrails.hitUnevaluated": "Die Prüfung konnte nicht ausgeführt werden.",
    "guardrails.subjectOperation": "Aufruf von {name}"
  }
});
