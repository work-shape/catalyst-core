import { defineTranslations } from "./translation-area";

export const guardrails = defineTranslations({
  en: {
    "guardrails.kind": "Guardrails",
    "guardrails.description": "Guardrails come from the release config and cannot be changed here.",
    "guardrails.search": "Search guardrails",
    "guardrails.empty":
      "No guardrails yet. A guardrail checks an action before it happens and warns or blocks. The operator sets them in the release config.",
    "guardrails.missing": "There is no guardrail with the id {name}.",
    "guardrails.scopeInstance": "Instance",
    "guardrails.checkTitle": "Check",
    "guardrails.checkDescription":
      "What the guardrail checks, and what happens when it finds something.",
    "guardrails.when": "When",
    "guardrails.eventApprovalRequest": "Before a request for approval is filed",
    "guardrails.appliesTo": "Applies to",
    "guardrails.appliesToEvery": "Every kind of request",
    "guardrails.checkKind": "How it checks",
    "guardrails.checkModelJudge": "Model check",
    "guardrails.onHit": "On a hit",
    "guardrails.outcomeWarn": "Warns",
    "guardrails.outcomeWarnText":
      "The request is filed with the reason, and whoever decides it sees the warning.",
    "guardrails.outcomeBlock": "Blocks",
    "guardrails.outcomeBlockText": "The request is not filed. Whoever asked is told the reason.",
    "guardrails.descriptionLabel": "Description",
    "guardrails.rule": "Rule",
    "guardrails.hitsTitle": "Recent hits",
    "guardrails.hitsDescription":
      "How often and when this guardrail warned or blocked, without naming anyone. Hits are kept as long as the audit log.",
    "guardrails.hitsEmpty": "No hits yet. Every warning and every block shows here.",
    "guardrails.hitsFailed": "The hits of this guardrail could not be loaded.",
    "guardrails.hitsMore": "Only the newest {count} hits are shown.",
    "guardrails.hitsLast7Days": "Last 7 days",
    "guardrails.hitsLast30Days": "Last 30 days",
    "guardrails.hitWarned": "Warned",
    "guardrails.hitBlocked": "Blocked",
    "guardrails.hitUnevaluated": "The check could not be run."
  },
  de: {
    "guardrails.kind": "Leitplanken",
    "guardrails.description":
      "Leitplanken kommen aus der Release-Konfiguration und lassen sich hier nicht ändern.",
    "guardrails.search": "Leitplanken durchsuchen",
    "guardrails.empty":
      "Noch keine Leitplanken. Eine Leitplanke prüft eine Aktion, bevor sie geschieht, und warnt oder blockiert. Der Betreiber legt sie in der Release-Konfiguration fest.",
    "guardrails.missing": "Es gibt keine Leitplanke mit der Kennung {name}.",
    "guardrails.scopeInstance": "Instanz",
    "guardrails.checkTitle": "Prüfung",
    "guardrails.checkDescription":
      "Was die Leitplanke prüft und was geschieht, wenn sie etwas findet.",
    "guardrails.when": "Wann",
    "guardrails.eventApprovalRequest": "Bevor eine Freigabe-Anfrage gestellt wird",
    "guardrails.appliesTo": "Gilt für",
    "guardrails.appliesToEvery": "Jede Art von Anfrage",
    "guardrails.checkKind": "Wie sie prüft",
    "guardrails.checkModelJudge": "Prüfung durch ein Modell",
    "guardrails.onHit": "Bei einem Treffer",
    "guardrails.outcomeWarn": "Warnt",
    "guardrails.outcomeWarnText":
      "Die Anfrage wird mit der Begründung gestellt, und wer sie entscheidet, sieht die Warnung.",
    "guardrails.outcomeBlock": "Blockiert",
    "guardrails.outcomeBlockText":
      "Die Anfrage wird nicht gestellt. Wer sie stellen wollte, erfährt die Begründung.",
    "guardrails.descriptionLabel": "Beschreibung",
    "guardrails.rule": "Regel",
    "guardrails.hitsTitle": "Letzte Treffer",
    "guardrails.hitsDescription":
      "Wie oft und wann diese Leitplanke gewarnt oder blockiert hat, ohne Personen zu nennen. Treffer bleiben so lange wie das Audit-Protokoll.",
    "guardrails.hitsEmpty": "Noch keine Treffer. Jede Warnung und jede Blockade erscheint hier.",
    "guardrails.hitsFailed": "Die Treffer dieser Leitplanke konnten nicht geladen werden.",
    "guardrails.hitsMore": "Nur die neuesten {count} Treffer werden gezeigt.",
    "guardrails.hitsLast7Days": "Letzte 7 Tage",
    "guardrails.hitsLast30Days": "Letzte 30 Tage",
    "guardrails.hitWarned": "Gewarnt",
    "guardrails.hitBlocked": "Blockiert",
    "guardrails.hitUnevaluated": "Die Prüfung konnte nicht ausgeführt werden."
  }
});
