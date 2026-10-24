import { defineTranslations } from "./translation-area";

/**
 * Spend limits (LU-2): Settings › Instance › Limits, a person's own usage in You › Usage, and
 * what the composer says at 80 percent and at a reached limit.
 */
export const usageLimits = defineTranslations({
  en: {
    "settings.limits": "Limits",
    "settings.ownUsage": "Usage",
    "limits.description":
      "Spend limits per day and per month, in the currency of the rate card. A message is sent only while the person, the workspace and the instance are all under their limits. Days and months are counted in UTC.",
    "limits.loadFailed": "The limits could not be loaded.",
    "limits.saveFailed": "The limit was not saved. Try again.",
    "limits.saved": "Saved. It applies from the next message.",
    "limits.daily": "Per day",
    "limits.monthly": "Per month",
    "limits.noLimit": "No limit",
    "limits.emptyMeansNone": "Leave a field empty for no limit.",
    "limits.save": "Save",
    "limits.remove": "Remove",
    "limits.add": "Add",
    "limits.instance": "Instance",
    "limits.instanceDescription":
      "All usage on this instance. Without a value here, the upper limit of the team that runs this instance applies.",
    "limits.ceiling":
      "The team that runs this instance allows at most {daily} a day and {monthly} a month.",
    "limits.ceilingDaily": "The team that runs this instance allows at most {daily} a day.",
    "limits.ceilingMonthly": "The team that runs this instance allows at most {monthly} a month.",
    "limits.ceilingNone": "The team that runs this instance sets no upper limit.",
    "limits.aboveCeiling":
      "This is above the most the team that runs this instance allows: {ceiling}.",
    "limits.inForce": "In force per day: {daily}; per month: {monthly}.",
    "limits.workspaces": "Shared workspaces",
    "limits.workspacesDescription":
      "All usage inside one shared workspace. Personal Workspaces have no workspace limit.",
    "limits.workspaceDefault": "Every shared workspace",
    "limits.users": "Users",
    "limits.usersDescription":
      "All of one person's own messages, in every workspace. Titles and checks the product adds do not count.",
    "limits.userDefault": "Every user",
    "limits.pickWorkspace": "Workspace",
    "limits.pickUser": "User",
    "limits.pickPlaceholder": "Choose…",
    "limits.unknownTarget": "No longer here",
    "limits.near": "Near a limit",
    "limits.nearDescription": "Workspaces and users at 80 percent of a limit or more.",
    "limits.nearEmpty": "Nobody is near a limit.",
    "limits.nearRow": "{percent} % of the {period} limit of {limit}",
    "limits.periodDay": "daily",
    "limits.periodMonth": "monthly",
    "limits.notPriced": "No rate card is configured, so limits cannot be counted in money.",
    "ownUsage.description":
      "What your own messages have cost against your limits. Titles and checks the product adds are not counted. Days and months are counted in UTC.",
    "ownUsage.loadFailed": "Your usage could not be loaded.",
    "ownUsage.section": "Your own messages",
    "ownUsage.today": "Today",
    "ownUsage.thisMonth": "This month",
    "ownUsage.spentOf": "{spent} of {limit}",
    "ownUsage.spentNoLimit": "{spent}, no limit",
    "ownUsage.reached": "Limit reached. It resets {reset}.",
    "ownUsage.otherLevels":
      "A limit of the workspace you work in or of the instance can also stop your messages. The composer says so when one does.",
    "composerLimit.ownDay":
      "You have reached your daily spend limit ({spent} of {limit}). It resets at midnight UTC. An administrator can raise it.",
    "composerLimit.ownMonth":
      "You have reached your monthly spend limit ({spent} of {limit}). It resets at the start of next month (UTC). An administrator can raise it.",
    "composerLimit.ownDayPlain":
      "You have reached your daily spend limit. It resets at midnight UTC. An administrator can raise it.",
    "composerLimit.ownMonthPlain":
      "You have reached your monthly spend limit. It resets at the start of next month (UTC). An administrator can raise it.",
    "composerLimit.workspaceDay":
      "This workspace has reached its daily spend limit. It resets at midnight UTC. An administrator can raise it; other workspaces keep working.",
    "composerLimit.workspaceMonth":
      "This workspace has reached its monthly spend limit. It resets at the start of next month (UTC). An administrator can raise it; other workspaces keep working.",
    "composerLimit.workspaceDayAmount":
      "This workspace has reached its daily spend limit ({spent} of {limit}). It resets at midnight UTC. An administrator can raise it; other workspaces keep working.",
    "composerLimit.workspaceMonthAmount":
      "This workspace has reached its monthly spend limit ({spent} of {limit}). It resets at the start of next month (UTC). An administrator can raise it; other workspaces keep working.",
    "composerLimit.instanceDay":
      "This instance has reached its daily spend limit. It resets at midnight UTC. An administrator can raise it.",
    "composerLimit.instanceMonth":
      "This instance has reached its monthly spend limit. It resets at the start of next month (UTC). An administrator can raise it.",
    "composerLimit.nearDay": "{amount} left of your daily spend limit.",
    "composerLimit.nearMonth": "{amount} left of your monthly spend limit.",
    "composerLimit.dismiss": "Dismiss"
  },
  de: {
    "settings.limits": "Limits",
    "settings.ownUsage": "Nutzung",
    "limits.description":
      "Ausgabenlimits pro Tag und pro Monat, in der Währung der Preisliste. Eine Nachricht wird nur gesendet, solange die Person, der Arbeitsbereich und die Instanz alle unter ihren Limits sind. Tage und Monate zählen in UTC.",
    "limits.loadFailed": "Die Limits konnten nicht geladen werden.",
    "limits.saveFailed": "Das Limit wurde nicht gespeichert. Versuche es erneut.",
    "limits.saved": "Gespeichert. Es gilt ab der nächsten Nachricht.",
    "limits.daily": "Pro Tag",
    "limits.monthly": "Pro Monat",
    "limits.noLimit": "Kein Limit",
    "limits.emptyMeansNone": "Lass ein Feld leer für kein Limit.",
    "limits.save": "Speichern",
    "limits.remove": "Entfernen",
    "limits.add": "Hinzufügen",
    "limits.instance": "Instanz",
    "limits.instanceDescription":
      "Die gesamte Nutzung dieser Instanz. Ohne Wert hier gilt die Obergrenze des Teams, das diese Instanz betreibt.",
    "limits.ceiling":
      "Das Team, das diese Instanz betreibt, erlaubt höchstens {daily} pro Tag und {monthly} pro Monat.",
    "limits.ceilingDaily":
      "Das Team, das diese Instanz betreibt, erlaubt höchstens {daily} pro Tag.",
    "limits.ceilingMonthly":
      "Das Team, das diese Instanz betreibt, erlaubt höchstens {monthly} pro Monat.",
    "limits.ceilingNone": "Das Team, das diese Instanz betreibt, setzt keine Obergrenze.",
    "limits.aboveCeiling":
      "Das liegt über dem, was das Team, das diese Instanz betreibt, höchstens erlaubt: {ceiling}.",
    "limits.inForce": "Es gilt pro Tag: {daily}; pro Monat: {monthly}.",
    "limits.workspaces": "Geteilte Arbeitsbereiche",
    "limits.workspacesDescription":
      "Die gesamte Nutzung in einem geteilten Arbeitsbereich. Persönliche Arbeitsbereiche haben kein Arbeitsbereichslimit.",
    "limits.workspaceDefault": "Jeder geteilte Arbeitsbereich",
    "limits.users": "Personen",
    "limits.usersDescription":
      "Alle eigenen Nachrichten einer Person, in jedem Arbeitsbereich. Titel und Prüfungen, die das Produkt hinzufügt, zählen nicht.",
    "limits.userDefault": "Jede Person",
    "limits.pickWorkspace": "Arbeitsbereich",
    "limits.pickUser": "Person",
    "limits.pickPlaceholder": "Auswählen…",
    "limits.unknownTarget": "Nicht mehr vorhanden",
    "limits.near": "Nahe am Limit",
    "limits.nearDescription": "Arbeitsbereiche und Personen ab 80 Prozent eines Limits.",
    "limits.nearEmpty": "Niemand ist nahe an einem Limit.",
    "limits.nearRow": "{percent} % des {period} Limits von {limit}",
    "limits.periodDay": "täglichen",
    "limits.periodMonth": "monatlichen",
    "limits.notPriced":
      "Es ist keine Preisliste eingerichtet, deshalb lassen sich Limits nicht in Geld zählen.",
    "ownUsage.description":
      "Was deine eigenen Nachrichten im Vergleich zu deinen Limits gekostet haben. Titel und Prüfungen, die das Produkt hinzufügt, zählen nicht. Tage und Monate zählen in UTC.",
    "ownUsage.loadFailed": "Deine Nutzung konnte nicht geladen werden.",
    "ownUsage.section": "Deine eigenen Nachrichten",
    "ownUsage.today": "Heute",
    "ownUsage.thisMonth": "Dieser Monat",
    "ownUsage.spentOf": "{spent} von {limit}",
    "ownUsage.spentNoLimit": "{spent}, kein Limit",
    "ownUsage.reached": "Limit erreicht. Es wird {reset} zurückgesetzt.",
    "ownUsage.otherLevels":
      "Auch ein Limit des Arbeitsbereichs, in dem du arbeitest, oder der Instanz kann deine Nachrichten stoppen. Das Eingabefeld sagt es dir, wenn das passiert.",
    "composerLimit.ownDay":
      "Du hast dein tägliches Ausgabenlimit erreicht ({spent} von {limit}). Es wird um Mitternacht UTC zurückgesetzt. Ein Administrator kann es erhöhen.",
    "composerLimit.ownMonth":
      "Du hast dein monatliches Ausgabenlimit erreicht ({spent} von {limit}). Es wird zu Beginn des nächsten Monats (UTC) zurückgesetzt. Ein Administrator kann es erhöhen.",
    "composerLimit.ownDayPlain":
      "Du hast dein tägliches Ausgabenlimit erreicht. Es wird um Mitternacht UTC zurückgesetzt. Ein Administrator kann es erhöhen.",
    "composerLimit.ownMonthPlain":
      "Du hast dein monatliches Ausgabenlimit erreicht. Es wird zu Beginn des nächsten Monats (UTC) zurückgesetzt. Ein Administrator kann es erhöhen.",
    "composerLimit.workspaceDay":
      "Dieser Arbeitsbereich hat sein tägliches Ausgabenlimit erreicht. Es wird um Mitternacht UTC zurückgesetzt. Ein Administrator kann es erhöhen; andere Arbeitsbereiche funktionieren weiter.",
    "composerLimit.workspaceMonth":
      "Dieser Arbeitsbereich hat sein monatliches Ausgabenlimit erreicht. Es wird zu Beginn des nächsten Monats (UTC) zurückgesetzt. Ein Administrator kann es erhöhen; andere Arbeitsbereiche funktionieren weiter.",
    "composerLimit.workspaceDayAmount":
      "Dieser Arbeitsbereich hat sein tägliches Ausgabenlimit erreicht ({spent} von {limit}). Es wird um Mitternacht UTC zurückgesetzt. Ein Administrator kann es erhöhen; andere Arbeitsbereiche funktionieren weiter.",
    "composerLimit.workspaceMonthAmount":
      "Dieser Arbeitsbereich hat sein monatliches Ausgabenlimit erreicht ({spent} von {limit}). Es wird zu Beginn des nächsten Monats (UTC) zurückgesetzt. Ein Administrator kann es erhöhen; andere Arbeitsbereiche funktionieren weiter.",
    "composerLimit.instanceDay":
      "Diese Instanz hat ihr tägliches Ausgabenlimit erreicht. Es wird um Mitternacht UTC zurückgesetzt. Ein Administrator kann es erhöhen.",
    "composerLimit.instanceMonth":
      "Diese Instanz hat ihr monatliches Ausgabenlimit erreicht. Es wird zu Beginn des nächsten Monats (UTC) zurückgesetzt. Ein Administrator kann es erhöhen.",
    "composerLimit.nearDay": "Von deinem täglichen Ausgabenlimit sind noch {amount} übrig.",
    "composerLimit.nearMonth": "Von deinem monatlichen Ausgabenlimit sind noch {amount} übrig.",
    "composerLimit.dismiss": "Ausblenden"
  }
});
