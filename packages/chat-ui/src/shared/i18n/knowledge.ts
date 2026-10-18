import { defineTranslations } from "./translation-area";

export const knowledge = defineTranslations({
  en: {
    "knowledge.kind": "Knowledge bases",
    "knowledge.description":
      "A knowledge base holds documents, or describes tables of a data store. An agent that has it answers from them and says where the answer comes from.",
    "knowledge.search": "Search knowledge bases",
    "knowledge.new": "New knowledge base",
    "knowledge.titleLabel": "Name",
    "knowledge.create": "Create knowledge base",
    "knowledge.deleteTitle": "Delete the knowledge base {name}?",
    "knowledge.deleteDescription":
      "Agents that have it can no longer answer from it. Its documents are deleted with it; a data store whose tables it describes stays as it is.",
    "knowledge.empty":
      "No knowledge bases yet. Add one for documents, such as contracts or manuals, or for the tables of a data store, and give it to an agent: the agent then answers questions from them.",
    "knowledge.emptyReadOnly":
      "No knowledge bases yet. Somebody who may build knowledge bases adds one.",
    "knowledge.missing": "There is no knowledge base with the id {name}.",
    "knowledge.tableCount": "1 table",
    "knowledge.tableCounts": "{count} tables",
    "knowledge.aboutTitle": "About",
    "knowledge.aboutDescription": "What people and agents read about this knowledge base.",
    "knowledge.descriptionLabel": "What it holds",
    "knowledge.descriptionHint":
      "An agent reads this to decide when to use it. Say what the rows are about, for example open invoices per customer.",
    "knowledge.descriptionHintDocuments":
      "An agent reads this to decide when to use it. Say what the documents are about, for example the staff handbook and its policies.",
    "knowledge.sourceTitle": "Source",
    "knowledge.sourceDescription":
      "The data store it reads and a sentence for each table an agent may use. It only reads: it creates no table and changes no row.",
    "knowledge.dataStore": "Data store",
    "knowledge.chooseDataStore": "Choose a data store",
    "knowledge.noDataStores":
      "There is no data store you may read yet. An agent or the API creates one.",
    "knowledge.dataStoresFailed": "The data stores could not be loaded.",
    "knowledge.chooseStoreFirst": "Choose a data store to see its tables.",
    "knowledge.tables": "Tables",
    "knowledge.tablesHint":
      "Choose the tables an agent may answer from and say in one sentence what a row of each is.",
    "knowledge.tableDescription": "What a row of {table} is",
    "knowledge.tableMissing": "Not in the data store",
    "knowledge.tablesFailed": "The tables of this data store could not be read.",
    "knowledge.tablesEmpty": "This data store has no tables yet.",
    "knowledge.statusTitle": "Status",
    "knowledge.statusDescription":
      "Whether the published version can read every table it describes. It is checked when it is published and when you check now.",
    "knowledge.statusPreparing": "Being set up",
    "knowledge.statusPreparingDescription":
      "Its store is being made. It takes documents once it is ready; this page shows that by itself.",
    "knowledge.statusOk": "Ready",
    "knowledge.statusNeedsAttention": "Needs attention",
    "knowledge.statusUnchecked": "Not checked yet",
    "knowledge.checkedAt": "Last checked",
    "knowledge.checkNow": "Check now",
    "knowledge.checkFailed": "The check could not be run.",
    "knowledge.tableReadable": "Readable",
    "knowledge.tableUnreadable": "Cannot be read",
    "knowledge.stateFailed": "The status could not be loaded.",
    "knowledge.filledByDescription":
      "The workflows that put documents into this knowledge base or take them out.",
    "knowledge.filledByTitle": "Filled by",
    "knowledge.processedByDescription":
      "The workflows that process its documents by document type.",
    "knowledge.processedByTitle": "Processed by",
    "knowledge.notPublished":
      "Publish the knowledge base to see whether it can read its tables and to try a query.",
    "knowledge.testTitle": "Test query",
    "knowledge.testDescription":
      "Ask the published version with one read-only SQL statement, as an agent does. Nothing is changed.",
    "knowledge.testSql": "SQL",
    "knowledge.testRun": "Run",
    "knowledge.testRow": "1 row",
    "knowledge.testRows": "{count} rows",
    "knowledge.testTruncated": "There are more rows than shown. Narrow the statement.",
    "knowledge.testFailed": "The query failed.",
    "knowledge.testNoRows": "The query returned no rows.",
    "knowledge.testRefused": "You may not query this knowledge base.",
    "knowledge.searchTitle": "Test search",
    "knowledge.searchDescription":
      "Search the published version as an agent does, with your own right to use it. Nothing is changed.",
    "knowledge.notPublishedSearch": "Publish the knowledge base to try a search.",
    "knowledge.searchQuery": "Search for",
    "knowledge.searchPlaceholder": "Words or a question",
    "knowledge.searchRun": "Search",
    "knowledge.searchPassage": "1 passage.",
    "knowledge.searchPassages": "{count} passages.",
    "knowledge.searchSignals": "Searched by {signals}.",
    "knowledge.signalSemantic": "meaning",
    "knowledge.signalKeyword": "words",
    "knowledge.signalTitle": "titles and file names",
    "knowledge.searchPage": "page {page}",
    "knowledge.searchNone": "No passage matches. Try other words.",
    "knowledge.searchFailed": "The search failed.",
    "knowledge.searchRefused": "You may not search this knowledge base.",
    "knowledge.agentSection": "Knowledge",
    "knowledge.agentSectionDescription":
      "The knowledge bases this agent answers from. It gets one tool that reads all of them and says in its answer which one it used.",
    "knowledge.agentNone": "No knowledge base chosen.",
    "knowledge.agentChoose": "Choose knowledge bases",
    "knowledge.agentNote": "Only a published knowledge base answers.",
    "knowledge.holdsLabel": "What it answers from",
    "knowledge.holdsDocuments": "Documents",
    "knowledge.holdsDocumentsDescription":
      "Files you add: PDF, DOCX, TXT or Markdown. Agents search them for words.",
    "knowledge.holdsTables": "Tables of a data store",
    "knowledge.holdsTablesDescription": "Agents read the rows of the tables you describe with SQL.",
    "knowledge.sourceDocumentsDescription":
      "It keeps its documents in a store of its own and searches them for words. You add documents once it is published.",
    "knowledge.statusDocumentsDescription":
      "Whether the published version can keep and search its documents. It is checked when it is published and when you check now.",
    "knowledge.notPublishedDocuments":
      "Publish the knowledge base to see its status and to add documents.",
    "knowledge.documentsTitle": "Documents",
    "knowledge.documentsDescription":
      "Everyone who may use this knowledge base finds every document in it, once the document is searchable.",
    "knowledge.documentsEmpty": "No documents yet. Add files from your conversations.",
    "knowledge.documentsEmptyReadOnly":
      "No documents yet. Somebody who may change this knowledge base adds them.",
    "knowledge.documentsFailed": "The documents could not be loaded.",
    "knowledge.documentsRefused": "You may not see the documents of this knowledge base.",
    "knowledge.documentsMore": "Show more",
    "knowledge.documentPending": "Being indexed",
    "knowledge.processingWaiting":
      "Processing is waiting: the knowledge base service is not responding.",
    "knowledge.documentIndexed": "Searchable",
    "knowledge.documentFailed": "Failed",
    "knowledge.originalReleased": "Original is stored at the source",
    "knowledge.retry": "Retry",
    "knowledge.retryFailed": "The document could not be retried.",
    "knowledge.retryRefused": "You may not change this knowledge base.",
    "knowledge.remove": "Remove",
    "knowledge.removeLabel": "Remove {name}",
    "knowledge.removeTitle": "Remove the document {name}?",
    "knowledge.removeDescription":
      "Nobody finds it in this knowledge base any more, and its copy is deleted. The file stays in its conversation.",
    "knowledge.removeFailed": "The document could not be removed.",
    "knowledge.removeSyncedRefused":
      "This document comes from a source and cannot be removed here. Remove it in the source, or narrow what the source brings in.",
    "knowledge.removed": "The document {name} was removed.",
    "knowledge.failureFormatUnsupported":
      "A knowledge base cannot read this format. It reads PDF, DOCX, TXT and Markdown.",
    "knowledge.failureOverLimit": "The file or its text is too large to read.",
    "knowledge.failureTooManyPages":
      "Page limit reached. Split the file, or ask the operator for a higher limit and retry.",
    "knowledge.failureTooManyPagesLimit":
      "Page limit reached. The current limit is {limit} pages. Split the file, or ask the operator for a higher limit and retry.",
    "knowledge.failureFileUnreadable":
      "The file is damaged, encrypted, or not the format its name says.",
    "knowledge.failureFileMissing": "The file is gone. Add it again.",
    "knowledge.failureExtraction": "Its text could not be read, even after several tries.",
    "knowledge.failureFormatUnavailable":
      "This instance reads no PDF or DOCX files. It reads TXT and Markdown.",
    "knowledge.failureTextUnreadable": "The file holds no readable text.",
    "knowledge.failureTextEmpty":
      "The file has no text to search, such as a scanned PDF without a text layer.",
    "knowledge.failureIndex": "Indexing failed, even after several tries.",
    "knowledge.failureProcessorOutput": "The processing result does not match the required format.",
    "knowledge.addDocuments": "Add documents",
    "knowledge.addDescription":
      "Choose files uploaded in the conversations of your workspace. The knowledge base keeps its own copy: deleting the conversation leaves the document.",
    "knowledge.addLimits":
      "Up to {count} files at once, each up to {size}: PDF, DOCX, TXT or Markdown.",
    "knowledge.addSearch": "Search files",
    "knowledge.addFiles": "Files",
    "knowledge.addNoFiles":
      "The conversations of your workspace hold no uploaded files yet. Upload a file in a conversation, then add it here.",
    "knowledge.addNoMatch": "No file matches.",
    "knowledge.addFilesFailed": "The files could not be loaded.",
    "knowledge.addChosen": "{count} of {max} chosen",
    "knowledge.addFull": "{max} chosen, the most for one add. Add the rest afterwards.",
    "knowledge.addSubmit": "Add",
    "knowledge.addFormatRefused": "A knowledge base reads PDF, DOCX, TXT and Markdown only.",
    "knowledge.addTooLarge": "Larger than {size}, the most a knowledge base takes.",
    "knowledge.addRefusedNotAvailable": "One of the files is no longer available to you.",
    "knowledge.addRefusedTooLarge": "One of the files is larger than {size}.",
    "knowledge.addRefusedDocumentsLimit":
      "The knowledge base already holds as many documents as it may.",
    "knowledge.addRefusedStoreNotReady":
      "The knowledge base cannot take documents right now. Check its status.",
    "knowledge.addRefusedFilesUnavailable":
      "This instance keeps no files, so it cannot add documents.",
    "knowledge.addRefused": "You may not add documents to this knowledge base.",
    "knowledge.addFailed": "The files could not be added.",
    "knowledge.addedOne": "1 document added. It is being indexed.",
    "knowledge.addedMany": "{count} documents added. They are being indexed."
  },
  de: {
    "knowledge.kind": "Wissensbasen",
    "knowledge.description":
      "Eine Wissensbasis enthält Dokumente oder beschreibt Tabellen eines Datenspeichers. Ein Agent, der sie hat, antwortet daraus und sagt, woher die Antwort kommt.",
    "knowledge.search": "Wissensbasen durchsuchen",
    "knowledge.new": "Neue Wissensbasis",
    "knowledge.titleLabel": "Name",
    "knowledge.create": "Wissensbasis anlegen",
    "knowledge.deleteTitle": "Wissensbasis {name} löschen?",
    "knowledge.deleteDescription":
      "Agenten, die sie haben, können nicht mehr aus ihr antworten. Ihre Dokumente werden mit ihr gelöscht; ein Datenspeicher, dessen Tabellen sie beschreibt, bleibt, wie er ist.",
    "knowledge.empty":
      "Noch keine Wissensbasen. Lege eine für Dokumente an, zum Beispiel Verträge oder Handbücher, oder für die Tabellen eines Datenspeichers, und gib sie einem Agenten: Er beantwortet dann Fragen daraus.",
    "knowledge.emptyReadOnly":
      "Noch keine Wissensbasen. Jemand, der Wissensbasen bauen darf, legt eine an.",
    "knowledge.missing": "Es gibt keine Wissensbasis mit der Kennung {name}.",
    "knowledge.tableCount": "1 Tabelle",
    "knowledge.tableCounts": "{count} Tabellen",
    "knowledge.aboutTitle": "Allgemein",
    "knowledge.aboutDescription": "Was Menschen und Agenten über diese Wissensbasis lesen.",
    "knowledge.descriptionLabel": "Was sie enthält",
    "knowledge.descriptionHint":
      "Ein Agent liest das, um zu entscheiden, wann er sie nutzt. Sag, worum es in den Zeilen geht, zum Beispiel offene Rechnungen je Kunde.",
    "knowledge.descriptionHintDocuments":
      "Ein Agent liest das, um zu entscheiden, wann er sie nutzt. Sag, worum es in den Dokumenten geht, zum Beispiel das Mitarbeiterhandbuch und seine Richtlinien.",
    "knowledge.sourceTitle": "Quelle",
    "knowledge.sourceDescription":
      "Der Datenspeicher, den sie liest, und ein Satz zu jeder Tabelle, die ein Agent nutzen darf. Sie liest nur: Sie legt keine Tabelle an und ändert keine Zeile.",
    "knowledge.dataStore": "Datenspeicher",
    "knowledge.chooseDataStore": "Datenspeicher wählen",
    "knowledge.noDataStores":
      "Es gibt noch keinen Datenspeicher, den du lesen darfst. Ein Agent oder die API legt einen an.",
    "knowledge.dataStoresFailed": "Die Datenspeicher konnten nicht geladen werden.",
    "knowledge.chooseStoreFirst": "Wähle einen Datenspeicher, um seine Tabellen zu sehen.",
    "knowledge.tables": "Tabellen",
    "knowledge.tablesHint":
      "Wähle die Tabellen, aus denen ein Agent antworten darf, und sag in einem Satz, was eine Zeile jeder Tabelle ist.",
    "knowledge.tableDescription": "Was eine Zeile von {table} ist",
    "knowledge.tableMissing": "Nicht im Datenspeicher",
    "knowledge.tablesFailed": "Die Tabellen dieses Datenspeichers konnten nicht gelesen werden.",
    "knowledge.tablesEmpty": "Dieser Datenspeicher hat noch keine Tabellen.",
    "knowledge.statusTitle": "Status",
    "knowledge.statusDescription":
      "Ob die veröffentlichte Version jede Tabelle lesen kann, die sie beschreibt. Das wird beim Veröffentlichen geprüft und wenn du jetzt prüfst.",
    "knowledge.statusPreparing": "Wird eingerichtet",
    "knowledge.statusPreparingDescription":
      "Ihr Speicher wird angelegt. Sobald er bereit ist, nimmt sie Dokumente an; diese Seite zeigt das von selbst.",
    "knowledge.statusOk": "Bereit",
    "knowledge.statusNeedsAttention": "Braucht Aufmerksamkeit",
    "knowledge.statusUnchecked": "Noch nicht geprüft",
    "knowledge.checkedAt": "Zuletzt geprüft",
    "knowledge.checkNow": "Jetzt prüfen",
    "knowledge.checkFailed": "Die Prüfung konnte nicht laufen.",
    "knowledge.tableReadable": "Lesbar",
    "knowledge.tableUnreadable": "Nicht lesbar",
    "knowledge.stateFailed": "Der Status konnte nicht geladen werden.",
    "knowledge.filledByDescription":
      "Die Workflows, die Dokumente in diese Wissensbasis bringen oder herausnehmen.",
    "knowledge.filledByTitle": "Gefüllt von",
    "knowledge.processedByDescription":
      "Die Workflows, die ihre Dokumente nach Dokumenttyp verarbeiten.",
    "knowledge.processedByTitle": "Verarbeitet von",
    "knowledge.notPublished":
      "Veröffentliche die Wissensbasis, um zu sehen, ob sie ihre Tabellen lesen kann, und um eine Abfrage zu testen.",
    "knowledge.testTitle": "Testabfrage",
    "knowledge.testDescription":
      "Frag die veröffentlichte Version mit einer lesenden SQL-Anweisung, so wie ein Agent. Es wird nichts geändert.",
    "knowledge.testSql": "SQL",
    "knowledge.testRun": "Ausführen",
    "knowledge.testRow": "1 Zeile",
    "knowledge.testRows": "{count} Zeilen",
    "knowledge.testTruncated": "Es gibt mehr Zeilen als gezeigt. Grenze die Anweisung ein.",
    "knowledge.testFailed": "Die Abfrage ist fehlgeschlagen.",
    "knowledge.testNoRows": "Die Abfrage hat keine Zeilen ergeben.",
    "knowledge.testRefused": "Du darfst diese Wissensbasis nicht abfragen.",
    "knowledge.searchTitle": "Testsuche",
    "knowledge.searchDescription":
      "Durchsuche die veröffentlichte Version so wie ein Agent, mit deinem eigenen Recht, sie zu nutzen. Es wird nichts geändert.",
    "knowledge.notPublishedSearch": "Veröffentliche die Wissensbasis, um eine Suche zu testen.",
    "knowledge.searchQuery": "Suchen nach",
    "knowledge.searchPlaceholder": "Wörter oder eine Frage",
    "knowledge.searchRun": "Suchen",
    "knowledge.searchPassage": "1 Textstelle.",
    "knowledge.searchPassages": "{count} Textstellen.",
    "knowledge.searchSignals": "Gesucht nach {signals}.",
    "knowledge.signalSemantic": "Bedeutung",
    "knowledge.signalKeyword": "Wörtern",
    "knowledge.signalTitle": "Titeln und Dateinamen",
    "knowledge.searchPage": "Seite {page}",
    "knowledge.searchNone": "Keine Textstelle passt. Versuch es mit anderen Wörtern.",
    "knowledge.searchFailed": "Die Suche ist fehlgeschlagen.",
    "knowledge.searchRefused": "Du darfst diese Wissensbasis nicht durchsuchen.",
    "knowledge.agentSection": "Wissen",
    "knowledge.agentSectionDescription":
      "Die Wissensbasen, aus denen dieser Agent antwortet. Er bekommt ein Werkzeug, das alle liest, und sagt in seiner Antwort, welche er genutzt hat.",
    "knowledge.agentNone": "Keine Wissensbasis gewählt.",
    "knowledge.agentChoose": "Wissensbasen wählen",
    "knowledge.agentNote": "Nur eine veröffentlichte Wissensbasis antwortet.",
    "knowledge.holdsLabel": "Woraus sie antwortet",
    "knowledge.holdsDocuments": "Dokumente",
    "knowledge.holdsDocumentsDescription":
      "Dateien, die du hinzufügst: PDF, DOCX, TXT oder Markdown. Agenten durchsuchen sie nach Wörtern.",
    "knowledge.holdsTables": "Tabellen eines Datenspeichers",
    "knowledge.holdsTablesDescription":
      "Agenten lesen die Zeilen der Tabellen, die du beschreibst, mit SQL.",
    "knowledge.sourceDocumentsDescription":
      "Sie hält ihre Dokumente in einem eigenen Speicher und durchsucht sie nach Wörtern. Dokumente fügst du hinzu, sobald sie veröffentlicht ist.",
    "knowledge.statusDocumentsDescription":
      "Ob die veröffentlichte Version ihre Dokumente speichern und durchsuchen kann. Das wird beim Veröffentlichen geprüft und wenn du jetzt prüfst.",
    "knowledge.notPublishedDocuments":
      "Veröffentliche die Wissensbasis, um ihren Status zu sehen und Dokumente hinzuzufügen.",
    "knowledge.documentsTitle": "Dokumente",
    "knowledge.documentsDescription":
      "Jeder, der diese Wissensbasis nutzen darf, findet jedes Dokument darin, sobald es durchsuchbar ist.",
    "knowledge.documentsEmpty":
      "Noch keine Dokumente. Füge Dateien aus deinen Unterhaltungen hinzu.",
    "knowledge.documentsEmptyReadOnly":
      "Noch keine Dokumente. Jemand, der diese Wissensbasis ändern darf, fügt sie hinzu.",
    "knowledge.documentsFailed": "Die Dokumente konnten nicht geladen werden.",
    "knowledge.documentsRefused": "Du darfst die Dokumente dieser Wissensbasis nicht sehen.",
    "knowledge.documentsMore": "Mehr zeigen",
    "knowledge.documentPending": "Wird indexiert",
    "knowledge.processingWaiting":
      "Verarbeitung wartet: Der Dienst für Wissensdatenbanken meldet sich nicht.",
    "knowledge.documentIndexed": "Durchsuchbar",
    "knowledge.documentFailed": "Fehlgeschlagen",
    "knowledge.originalReleased": "Original liegt in der Quelle",
    "knowledge.retry": "Erneut versuchen",
    "knowledge.retryFailed": "Der neue Versuch konnte nicht gestartet werden.",
    "knowledge.retryRefused": "Du darfst diese Wissensbasis nicht ändern.",
    "knowledge.remove": "Entfernen",
    "knowledge.removeLabel": "{name} entfernen",
    "knowledge.removeTitle": "Dokument {name} entfernen?",
    "knowledge.removeDescription":
      "Niemand findet es danach mehr in dieser Wissensbasis, und ihre Kopie wird gelöscht. Die Datei bleibt in ihrer Unterhaltung.",
    "knowledge.removeFailed": "Das Dokument konnte nicht entfernt werden.",
    "knowledge.removeSyncedRefused":
      "Dieses Dokument kommt aus einer Quelle und lässt sich hier nicht entfernen. Entferne es in der Quelle, oder grenze ein, was die Quelle übernimmt.",
    "knowledge.removed": "Das Dokument {name} wurde entfernt.",
    "knowledge.failureFormatUnsupported":
      "Dieses Format kann eine Wissensbasis nicht lesen. Sie liest PDF, DOCX, TXT und Markdown.",
    "knowledge.failureOverLimit": "Die Datei oder ihr Text ist zu groß zum Auslesen.",
    "knowledge.failureTooManyPages":
      "Seitengrenze erreicht. Teile die Datei, oder bitte den Betreiber um eine höhere Grenze und versuche es dann erneut.",
    "knowledge.failureTooManyPagesLimit":
      "Seitengrenze erreicht. Die aktuelle Grenze liegt bei {limit} Seiten. Teile die Datei, oder bitte den Betreiber um eine höhere Grenze und versuche es dann erneut.",
    "knowledge.failureFileUnreadable":
      "Die Datei ist beschädigt, verschlüsselt oder nicht das Format, das ihr Name angibt.",
    "knowledge.failureFileMissing": "Die Datei ist nicht mehr da. Füge sie neu hinzu.",
    "knowledge.failureExtraction":
      "Ihr Text ließ sich auch nach mehreren Versuchen nicht auslesen.",
    "knowledge.failureFormatUnavailable":
      "Diese Instanz liest keine PDF- und DOCX-Dateien. Sie liest TXT und Markdown.",
    "knowledge.failureTextUnreadable": "Die Datei enthält keinen lesbaren Text.",
    "knowledge.failureTextEmpty":
      "Die Datei hat keinen Text zum Durchsuchen, zum Beispiel ein gescanntes PDF ohne Textebene.",
    "knowledge.failureIndex": "Das Indexieren ist auch nach mehreren Versuchen fehlgeschlagen.",
    "knowledge.failureProcessorOutput":
      "Das Verarbeitungsergebnis entspricht nicht dem erforderlichen Format.",
    "knowledge.addDocuments": "Dokumente hinzufügen",
    "knowledge.addDescription":
      "Wähle Dateien, die in Unterhaltungen deines Arbeitsbereichs hochgeladen wurden. Die Wissensbasis behält eine eigene Kopie: Wird die Unterhaltung gelöscht, bleibt das Dokument.",
    "knowledge.addLimits":
      "Bis zu {count} Dateien auf einmal, jede bis {size}: PDF, DOCX, TXT oder Markdown.",
    "knowledge.addSearch": "Dateien suchen",
    "knowledge.addFiles": "Dateien",
    "knowledge.addNoFiles":
      "In den Unterhaltungen deines Arbeitsbereichs gibt es noch keine hochgeladenen Dateien. Lade eine Datei in einer Unterhaltung hoch und füge sie dann hier hinzu.",
    "knowledge.addNoMatch": "Keine Datei passt.",
    "knowledge.addFilesFailed": "Die Dateien konnten nicht geladen werden.",
    "knowledge.addChosen": "{count} von {max} gewählt",
    "knowledge.addFull":
      "{max} gewählt, mehr gehen auf einmal nicht. Füge die übrigen danach hinzu.",
    "knowledge.addSubmit": "Hinzufügen",
    "knowledge.addFormatRefused": "Eine Wissensbasis liest nur PDF, DOCX, TXT und Markdown.",
    "knowledge.addTooLarge": "Größer als {size}, mehr nimmt eine Wissensbasis nicht.",
    "knowledge.addRefusedNotAvailable": "Eine der Dateien steht dir nicht mehr zur Verfügung.",
    "knowledge.addRefusedTooLarge": "Eine der Dateien ist größer als {size}.",
    "knowledge.addRefusedDocumentsLimit":
      "Die Wissensbasis enthält schon so viele Dokumente, wie sie darf.",
    "knowledge.addRefusedStoreNotReady":
      "Die Wissensbasis kann gerade keine Dokumente aufnehmen. Prüf ihren Status.",
    "knowledge.addRefusedFilesUnavailable":
      "Diese Instanz speichert keine Dateien und kann darum keine Dokumente aufnehmen.",
    "knowledge.addRefused": "Du darfst dieser Wissensbasis keine Dokumente hinzufügen.",
    "knowledge.addFailed": "Die Dateien konnten nicht hinzugefügt werden.",
    "knowledge.addedOne": "1 Dokument hinzugefügt. Es wird jetzt indexiert.",
    "knowledge.addedMany": "{count} Dokumente hinzugefügt. Sie werden jetzt indexiert."
  }
});
