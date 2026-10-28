import { defineTranslations } from "./translation-area";

export const workspace = defineTranslations({
  en: {
    accountDisabledDescription:
      "An administrator disabled your account. Ask an admin of your organization to turn it back on.",
    accountDisabledTitle: "Your account is disabled",
    accountMenuLabel: "{label} account",
    documentation: "Documentation",
    documentationOpensNewTab: "Documentation, opens in a new tab",
    releaseVersion: "Version {version}",
    checkingSession: "Checking session",
    couldNotLoadWorkspace: "Could not load workspace",
    loadingUser: "Loading",
    noConversations: "No conversations yet.",
    openSidebar: "Open sidebar",
    runCommandNotTaken:
      "The reply was stopped because code could not be run. Code execution is unavailable right now. This is a problem of the platform, not of your input. Try again later.",
    runInterrupted: "The reply was interrupted. Please send your message again.",
    runTimedOut:
      "The reply was interrupted. It does not continue on its own. The steps already done are kept: write “continue” and the agent picks up where it left off.",
    runRateLimited:
      "The model is overloaded right now, so the reply was interrupted. It does not continue on its own. The steps already done are kept: in about a minute, write “continue” and the agent picks up where it left off.",
    runPersonalDataModelRegion:
      "This model is not allowed in a conversation with data from personal connections. Choose another model or start a new conversation.",
    runModelNotPriced:
      "This model cannot be used at the moment. Choose another model or ask an administrator.",
    runModelNotPricedOperator:
      "This model has no price on the rate card, so its cost cannot be counted against the spend budget. Choose another model until the team that runs this instance has added the price.",
    runUsageLimitReached: "A usage limit stopped this reply. {advice}",
    runUsageLimitNamed:
      "The {period} limit on {metric} stopped this reply. It counts {scope} and resets {reset}. {advice}",
    runUsageLimitAdvice:
      "Your answer so far is kept. Ask an administrator of this instance to check the usage limits.",
    runUsageLimitAdviceOperator:
      "Your answer so far is kept. Settings › Usage shows the usage limits and what has been used. Ask the team that runs this instance to review the limits.",
    runUsageLimitPeriodDay: "daily",
    runUsageLimitPeriodMonth: "monthly",
    runUsageLimitMetricModelCallCount: "model calls",
    runUsageLimitMetricTokens: "tokens",
    runUsageLimitMetricCostMicros: "spending",
    runUsageLimitScopeUser: "your own calls",
    runUsageLimitScopeSystem: "the calls the product makes",
    runUsageLimitScopeInstance: "the calls of everyone on this instance",
    runUsageLimitScopeWorkspace: "the calls of everyone in this workspace",
    runUsageLimitResetDay: "at midnight UTC",
    runUsageLimitResetMonth: "at the start of next month (UTC)",
    runNotStarted:
      "The reply could not be started because the service is busy or unavailable. Please send your message again.",
    runStopped: "The reply was stopped.",
    runToolSilent:
      "The reply was stopped: it waited for the tool {tool}, which did not answer in time. Please send your message again.",
    returnToChat: "Return to chat",
    selectAgent: "Select agent",
    sessionCheckingDescription: "Your account is being checked before the chat loads.",
    sessionUnavailableDescription: "The service could not be reached. Try again.",
    sessionUnavailableTitle: "Service unavailable",
    signOut: "Sign out",
    signingOut: "Signing out",
    switchToDarkTheme: "Switch to dark theme",
    switchToLightTheme: "Switch to light theme",
    testEnvironment: "Test environment",
    userFallback: "User",
    workspaceLoadFailedDescription: "Please refresh the page and try again.",
    workspaceLoadingDescription: "Your workspace is being prepared."
  },
  de: {
    accountDisabledDescription:
      "Dein Konto wurde deaktiviert. Bitte einen Admin deiner Organisation, es wieder freizuschalten.",
    accountDisabledTitle: "Dein Konto ist deaktiviert",
    accountMenuLabel: "Konto von {label}",
    documentation: "Dokumentation",
    documentationOpensNewTab: "Dokumentation, öffnet in neuem Tab",
    releaseVersion: "Version {version}",
    checkingSession: "Sitzung wird geprüft",
    couldNotLoadWorkspace: "Arbeitsbereich konnte nicht geladen werden",
    loadingUser: "Lädt",
    noConversations: "Noch keine Unterhaltungen.",
    openSidebar: "Seitenleiste öffnen",
    runCommandNotTaken:
      "Die Antwort wurde gestoppt, weil Code gerade nicht ausgeführt werden kann. Das ist ein Problem der Plattform, nicht deiner Eingabe. Versuche es später erneut.",
    runInterrupted: "Die Antwort wurde unterbrochen. Bitte sende deine Nachricht erneut.",
    runTimedOut:
      "Die Antwort wurde unterbrochen. Sie geht nicht von selbst weiter. Die erledigten Schritte bleiben erhalten: Schreib „weiter“, dann macht der Agent dort weiter, wo er aufgehört hat.",
    runRateLimited:
      "Das Modell ist gerade überlastet, deshalb wurde die Antwort unterbrochen. Sie geht nicht von selbst weiter. Die erledigten Schritte bleiben erhalten: Schreib in etwa einer Minute „weiter“, dann macht der Agent dort weiter, wo er aufgehört hat.",
    runPersonalDataModelRegion:
      "Dieses Modell ist für Unterhaltungen mit Daten aus persönlichen Verbindungen nicht freigegeben. Wähle ein anderes Modell oder beginne eine neue Unterhaltung.",
    runModelNotPriced:
      "Dieses Modell kann gerade nicht verwendet werden. Wähle ein anderes Modell oder wende dich an einen Administrator.",
    runModelNotPricedOperator:
      "Für dieses Modell steht kein Preis in der Preisliste, deshalb lassen sich seine Kosten nicht auf das Budget anrechnen. Wähle ein anderes Modell, bis das Team, das diese Instanz betreibt, den Preis eingetragen hat.",
    runUsageLimitReached: "Eine Nutzungsgrenze hat diese Antwort gestoppt. {advice}",
    runUsageLimitNamed:
      "Die {period} Grenze für {metric} hat diese Antwort gestoppt. Sie zählt {scope} und wird {reset} zurückgesetzt. {advice}",
    runUsageLimitAdvice:
      "Was bisher geantwortet wurde, bleibt erhalten. Bitte einen Administrator dieser Instanz, die Nutzungsgrenzen zu prüfen.",
    runUsageLimitAdviceOperator:
      "Was bisher geantwortet wurde, bleibt erhalten. Unter Einstellungen › Nutzung siehst du die Nutzungsgrenzen und den Verbrauch. Bitte das Team, das diese Instanz betreibt, die Grenzen zu prüfen.",
    runUsageLimitPeriodDay: "tägliche",
    runUsageLimitPeriodMonth: "monatliche",
    runUsageLimitMetricModelCallCount: "Modellaufrufe",
    runUsageLimitMetricTokens: "Tokens",
    runUsageLimitMetricCostMicros: "Ausgaben",
    runUsageLimitScopeUser: "deine eigenen Aufrufe",
    runUsageLimitScopeSystem: "die Aufrufe des Produkts",
    runUsageLimitScopeInstance: "die Aufrufe aller auf dieser Instanz",
    runUsageLimitScopeWorkspace: "die Aufrufe aller in diesem Arbeitsbereich",
    runUsageLimitResetDay: "um Mitternacht UTC",
    runUsageLimitResetMonth: "zu Beginn des nächsten Monats (UTC)",
    runNotStarted:
      "Die Antwort konnte nicht gestartet werden, weil der Dienst ausgelastet oder nicht erreichbar ist. Bitte sende deine Nachricht erneut.",
    runStopped: "Die Antwort wurde gestoppt.",
    runToolSilent:
      "Die Antwort wurde gestoppt: Sie hat auf das Werkzeug {tool} gewartet, das nicht rechtzeitig geantwortet hat. Bitte sende deine Nachricht erneut.",
    returnToChat: "Zurück zum Chat",
    selectAgent: "Agent auswählen",
    sessionCheckingDescription: "Dein Konto wird geprüft, bevor der Chat geladen wird.",
    sessionUnavailableDescription:
      "Der Dienst konnte nicht erreicht werden. Versuche es noch einmal.",
    sessionUnavailableTitle: "Dienst nicht erreichbar",
    signOut: "Abmelden",
    signingOut: "Abmeldung läuft",
    switchToDarkTheme: "Zum dunklen Design wechseln",
    switchToLightTheme: "Zum hellen Design wechseln",
    testEnvironment: "Testumgebung",
    userFallback: "Benutzer",
    workspaceLoadFailedDescription: "Bitte lade die Seite neu und versuche es noch einmal.",
    workspaceLoadingDescription: "Dein Arbeitsbereich wird vorbereitet."
  }
});
