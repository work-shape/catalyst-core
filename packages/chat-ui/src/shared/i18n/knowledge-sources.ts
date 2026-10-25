import { defineTranslations } from "./translation-area";

// The synced sources of a Knowledge Base of documents on its page (SRC-2): the folders a
// Connection reads into it, and how far each sync is.
export const knowledgeSources = defineTranslations({
  en: {
    "knowledgeSources.title": "Synced sources",
    "knowledgeSources.description":
      "Folders a connection reads into this knowledge base. Everyone with access to it finds what is in them, read with the connection's shared account.",
    "knowledgeSources.empty": "No source yet. Add one to sync folders through a connection.",
    "knowledgeSources.emptyReadOnly": "No synced source.",
    "knowledgeSources.add": "Add source",
    "knowledgeSources.chooseConnection": "Choose a connection",
    "knowledgeSources.noConnections": "No connection here syncs folders yet.",
    "knowledgeSources.noConnectionsFor": "To sync folders from {types}, create a connection first.",
    "knowledgeSources.noDocumentTypes":
      "This instance connects no document source yet. Files are added under Documents.",
    "knowledgeSources.connectionsFailed": "The connections could not be read.",
    "knowledgeSources.connection": "Connection",
    "knowledgeSources.folders": "Folder IDs",
    "knowledgeSources.foldersHint":
      "One per line, or separated by commas. Only what is in these folders and below them is read.",
    "knowledgeSources.include": "Only files named",
    "knowledgeSources.includeHint": "Patterns, one per line, such as *.pdf. Empty for every file.",
    "knowledgeSources.exclude": "Leave out paths",
    "knowledgeSources.excludeHint": "Patterns on the path below the folders, one per line.",
    "knowledgeSources.remove": "Remove",
    "knowledgeSources.removeLabel": "Remove source {id}",
    "knowledgeSources.draftNote":
      "A source that is added, changed or removed takes effect when the draft is published.",
    "knowledgeSources.notPublished": "It syncs once it is published.",
    "knowledgeSources.stateInitial": "Initial import running",
    "knowledgeSources.stateSyncing": "Syncing",
    "knowledgeSources.stateWaiting": "Waiting for confirmation",
    "knowledgeSources.confirmTitle": "Large first import",
    "knowledgeSources.confirmStatement": "{items} files, {size}, estimated embedding cost {cost}.",
    "knowledgeSources.confirmNoPrice":
      "{items} files, {size}. The embedding model has no price, so the cost is unknown.",
    "knowledgeSources.confirmNoEmbedding":
      "{items} files, {size}. This knowledge base does not search by meaning, so nothing is embedded.",
    "knowledgeSources.confirmStopped":
      "The first {stop} are being taken in. The rest waits until someone who may publish this knowledge base continues the import.",
    "knowledgeSources.confirmRange": "{min} to {max}",
    "knowledgeSources.confirmPassages": "Passages (estimated)",
    "knowledgeSources.confirmTokens": "Tokens (estimated)",
    "knowledgeSources.confirmNoRoom":
      "The store may not have room: {used} used, up to about {added} more, a limit of {limit}.",
    "knowledgeSources.confirm": "Continue import",
    "knowledgeSources.confirmed": "The import goes on.",
    "knowledgeSources.confirmFailed": "The import could not be continued.",
    "knowledgeSources.confirmRefused":
      "Only someone who may publish this knowledge base can continue the import.",
    "knowledgeSources.stateCurrent": "Up to date",
    "knowledgeSources.stateUnreachable": "Source unreachable",
    "knowledgeSources.stateRefused": "Access refused",
    "knowledgeSources.stateFailed": "Last sync failed",
    "knowledgeSources.stateNever": "Not synced yet",
    "knowledgeSources.found": "{count} found",
    "knowledgeSources.searchable": "{count} searchable",
    "knowledgeSources.failedCount": "{count} failed",
    "knowledgeSources.estimatedEnd": "Expected to finish",
    "knowledgeSources.lastSync": "Last sync",
    "knowledgeSources.lastChange": "Last change processed",
    "knowledgeSources.oldestOpen": "Oldest open change",
    "knowledgeSources.failures": "Failed items",
    "knowledgeSources.failureItems": "{count} items",
    "knowledgeSources.failureItem": "1 item",
    "knowledgeSources.retry": "Try again",
    "knowledgeSources.retryLabel": "Try the items that failed for this reason again",
    "knowledgeSources.retried": "{count} items are fetched again.",
    "knowledgeSources.retryFailed": "The items could not be tried again.",
    "knowledgeSources.syncNow": "Sync now",
    "knowledgeSources.syncStarted": "The sync has started.",
    "knowledgeSources.syncFailed": "The sync could not be started.",
    "knowledgeSources.refused": "You may not change this knowledge base.",
    "knowledgeSources.statusFailed": "The state of the sources could not be read.",
    "knowledgeSources.statusRefused": "You may not read the state of the sources.",
    "knowledgeSources.failureUnreachable": "The source did not answer.",
    "knowledgeSources.failureRefused": "The source refused the account's access.",
    "knowledgeSources.failureFetch": "Fetching failed, even after several tries.",
    "knowledgeSources.failureLimit": "The knowledge base holds as many documents as it may.",
    "knowledgeSources.failureItemInvalid": "The source described the item in a way it cannot read.",
    "knowledgeSources.failureNotAllowed": "The source does not allow the file to be downloaded.",
    "knowledgeSources.failureIngestCancelled": "The workflow's run ended before it was taken in.",
    "knowledgeSources.failureItemRemoved": "Removed by hand. The workflow does not bring it back.",
    "knowledgeSources.release": "Allow again",
    "knowledgeSources.releaseLabel": "Let the workflow's next run bring the removed items back",
    "knowledgeSources.released":
      "{count} items are allowed again. The workflow's next run brings them back.",
    "knowledgeSources.workflowSources": "Filled by workflows",
    "knowledgeSources.workflow": "Workflow",
    "knowledgeSources.stateIngesting": "Taking documents in",
    "knowledgeSources.stateRunEnded": "Last run ended early",
    "knowledgeSources.lastRun": "Last run",
    "knowledgeSources.workflowFreshness": "As of the last run {elapsed} ago",
    "knowledgeSources.workflowNote":
      "The workflow's runs decide what this source holds: a complete run removes what it no longer names. To keep a document out, remove it under Documents: no run brings it back."
  },
  de: {
    "knowledgeSources.title": "Synchronisierte Quellen",
    "knowledgeSources.description":
      "Ordner, die eine Verbindung in diese Wissensbasis liest. Alle mit Zugriff darauf finden, was darin liegt, gelesen mit dem gemeinsamen Konto der Verbindung.",
    "knowledgeSources.empty":
      "Noch keine Quelle. Füge eine hinzu, um Ordner über eine Verbindung zu synchronisieren.",
    "knowledgeSources.emptyReadOnly": "Keine synchronisierte Quelle.",
    "knowledgeSources.add": "Quelle hinzufügen",
    "knowledgeSources.chooseConnection": "Verbindung wählen",
    "knowledgeSources.noConnections": "Noch keine Verbindung hier synchronisiert Ordner.",
    "knowledgeSources.noConnectionsFor":
      "Um Ordner aus {types} zu synchronisieren, lege zuerst eine Verbindung an.",
    "knowledgeSources.noDocumentTypes":
      "Diese Instanz verbindet noch keine Dokumentquelle. Dateien fügst du unter Dokumente hinzu.",
    "knowledgeSources.connectionsFailed": "Die Verbindungen ließen sich nicht lesen.",
    "knowledgeSources.connection": "Verbindung",
    "knowledgeSources.folders": "Ordner-IDs",
    "knowledgeSources.foldersHint":
      "Eine pro Zeile oder durch Kommas getrennt. Gelesen wird nur, was in diesen Ordnern und darunter liegt.",
    "knowledgeSources.include": "Nur Dateien mit Namen",
    "knowledgeSources.includeHint": "Muster, eines pro Zeile, etwa *.pdf. Leer für alle Dateien.",
    "knowledgeSources.exclude": "Pfade auslassen",
    "knowledgeSources.excludeHint": "Muster auf dem Pfad unterhalb der Ordner, eines pro Zeile.",
    "knowledgeSources.remove": "Entfernen",
    "knowledgeSources.removeLabel": "Quelle {id} entfernen",
    "knowledgeSources.draftNote":
      "Eine hinzugefügte, geänderte oder entfernte Quelle gilt, sobald der Entwurf veröffentlicht ist.",
    "knowledgeSources.notPublished": "Sie wird nach dem Veröffentlichen synchronisiert.",
    "knowledgeSources.stateInitial": "Erstimport läuft",
    "knowledgeSources.stateSyncing": "Synchronisiert gerade",
    "knowledgeSources.stateWaiting": "Wartet auf Bestätigung",
    "knowledgeSources.confirmTitle": "Großer Erstimport",
    "knowledgeSources.confirmStatement":
      "{items} Dateien, {size}, geschätzte Kosten der Einbettung {cost}.",
    "knowledgeSources.confirmNoPrice":
      "{items} Dateien, {size}. Das Modell der Einbettung hat keinen Preis, die Kosten sind also unbekannt.",
    "knowledgeSources.confirmNoEmbedding":
      "{items} Dateien, {size}. Diese Wissensbasis sucht nicht nach Bedeutung, also wird nichts eingebettet.",
    "knowledgeSources.confirmStopped":
      "Die ersten {stop} werden eingelesen. Der Rest wartet, bis jemand, der diese Wissensbasis veröffentlichen darf, den Import fortsetzt.",
    "knowledgeSources.confirmRange": "{min} bis {max}",
    "knowledgeSources.confirmPassages": "Passagen (geschätzt)",
    "knowledgeSources.confirmTokens": "Tokens (geschätzt)",
    "knowledgeSources.confirmNoRoom":
      "Der Speicher hat womöglich keinen Platz: {used} belegt, bis zu etwa {added} kämen dazu, die Grenze liegt bei {limit}.",
    "knowledgeSources.confirm": "Import fortsetzen",
    "knowledgeSources.confirmed": "Der Import geht weiter.",
    "knowledgeSources.confirmFailed": "Der Import ließ sich nicht fortsetzen.",
    "knowledgeSources.confirmRefused":
      "Nur wer diese Wissensbasis veröffentlichen darf, kann den Import fortsetzen.",
    "knowledgeSources.stateCurrent": "Aktuell",
    "knowledgeSources.stateUnreachable": "Quelle nicht erreichbar",
    "knowledgeSources.stateRefused": "Zugang abgelehnt",
    "knowledgeSources.stateFailed": "Letzte Synchronisierung fehlgeschlagen",
    "knowledgeSources.stateNever": "Noch nicht synchronisiert",
    "knowledgeSources.found": "{count} gefunden",
    "knowledgeSources.searchable": "{count} durchsuchbar",
    "knowledgeSources.failedCount": "{count} fehlgeschlagen",
    "knowledgeSources.estimatedEnd": "Voraussichtlich fertig",
    "knowledgeSources.lastSync": "Letzte Synchronisierung",
    "knowledgeSources.lastChange": "Letzte Änderung verarbeitet",
    "knowledgeSources.oldestOpen": "Älteste offene Änderung",
    "knowledgeSources.failures": "Fehlgeschlagene Elemente",
    "knowledgeSources.failureItems": "{count} Elemente",
    "knowledgeSources.failureItem": "1 Element",
    "knowledgeSources.retry": "Erneut versuchen",
    "knowledgeSources.retryLabel":
      "Die aus diesem Grund fehlgeschlagenen Elemente erneut versuchen",
    "knowledgeSources.retried": "{count} Elemente werden erneut geladen.",
    "knowledgeSources.retryFailed": "Die Elemente ließen sich nicht erneut versuchen.",
    "knowledgeSources.syncNow": "Jetzt synchronisieren",
    "knowledgeSources.syncStarted": "Die Synchronisierung läuft.",
    "knowledgeSources.syncFailed": "Die Synchronisierung ließ sich nicht starten.",
    "knowledgeSources.refused": "Du darfst diese Wissensbasis nicht ändern.",
    "knowledgeSources.statusFailed": "Der Stand der Quellen ließ sich nicht lesen.",
    "knowledgeSources.statusRefused": "Du darfst den Stand der Quellen nicht lesen.",
    "knowledgeSources.failureUnreachable": "Die Quelle hat nicht geantwortet.",
    "knowledgeSources.failureRefused": "Die Quelle hat den Zugriff des Kontos abgelehnt.",
    "knowledgeSources.failureFetch": "Das Laden ist auch nach mehreren Versuchen fehlgeschlagen.",
    "knowledgeSources.failureLimit": "Die Wissensbasis enthält so viele Dokumente, wie sie darf.",
    "knowledgeSources.failureItemInvalid":
      "Die Quelle hat das Element so beschrieben, dass es sich nicht lesen lässt.",
    "knowledgeSources.failureNotAllowed": "Die Quelle erlaubt nicht, die Datei herunterzuladen.",
    "knowledgeSources.failureIngestCancelled":
      "Der Lauf des Workflows endete, bevor es übernommen wurde.",
    "knowledgeSources.failureItemRemoved":
      "Von Hand entfernt. Der Workflow bringt es nicht zurück.",
    "knowledgeSources.release": "Wieder zulassen",
    "knowledgeSources.releaseLabel":
      "Der nächste Lauf des Workflows darf die entfernten Elemente zurückbringen",
    "knowledgeSources.released":
      "{count} Elemente sind wieder zugelassen. Der nächste Lauf des Workflows bringt sie zurück.",
    "knowledgeSources.workflowSources": "Von Workflows gefüllt",
    "knowledgeSources.workflow": "Workflow",
    "knowledgeSources.stateIngesting": "Übernahme läuft",
    "knowledgeSources.stateRunEnded": "Letzter Lauf vorzeitig beendet",
    "knowledgeSources.lastRun": "Letzter Lauf",
    "knowledgeSources.workflowFreshness": "Stand: letzter Lauf vor {elapsed}",
    "knowledgeSources.workflowNote":
      "Was diese Quelle enthält, bestimmen die Läufe des Workflows: Ein vollständiger Lauf entfernt, was er nicht mehr nennt. Um ein Dokument herauszuhalten, entferne es unter Dokumente: Kein Lauf bringt es zurück."
  }
});
