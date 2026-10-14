import { defineTranslations } from "./translation-area";

export const knowledge = defineTranslations({
  en: {
    "knowledge.kind": "Knowledge bases",
    "knowledge.description":
      "A knowledge base describes tables of a data store. An agent that has it answers from their rows and says where the answer comes from.",
    "knowledge.search": "Search knowledge bases",
    "knowledge.new": "New knowledge base",
    "knowledge.titleLabel": "Name",
    "knowledge.create": "Create knowledge base",
    "knowledge.deleteTitle": "Delete the knowledge base {name}?",
    "knowledge.deleteDescription":
      "Agents that have it can no longer answer from it. The data store and its rows stay as they are.",
    "knowledge.empty":
      "No knowledge bases yet. Add one for the tables of a data store, for example customers or invoices, and give it to an agent: the agent then answers questions from their rows.",
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
    "knowledge.statusOk": "Ready",
    "knowledge.statusNeedsAttention": "Needs attention",
    "knowledge.statusUnchecked": "Not checked yet",
    "knowledge.checkedAt": "Last checked",
    "knowledge.checkNow": "Check now",
    "knowledge.checkFailed": "The check could not be run.",
    "knowledge.tableReadable": "Readable",
    "knowledge.tableUnreadable": "Cannot be read",
    "knowledge.stateFailed": "The status could not be loaded.",
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
    "knowledge.agentSection": "Knowledge",
    "knowledge.agentSectionDescription":
      "The knowledge bases this agent answers from. It gets one tool that reads all of them and says in its answer which one it used.",
    "knowledge.agentNone": "No knowledge base chosen.",
    "knowledge.agentChoose": "Choose knowledge bases",
    "knowledge.agentNote": "Only a published knowledge base answers."
  },
  de: {
    "knowledge.kind": "Wissensbasen",
    "knowledge.description":
      "Eine Wissensbasis beschreibt Tabellen eines Datenspeichers. Ein Agent, der sie hat, antwortet aus ihren Zeilen und sagt, woher die Antwort kommt.",
    "knowledge.search": "Wissensbasen durchsuchen",
    "knowledge.new": "Neue Wissensbasis",
    "knowledge.titleLabel": "Name",
    "knowledge.create": "Wissensbasis anlegen",
    "knowledge.deleteTitle": "Wissensbasis {name} löschen?",
    "knowledge.deleteDescription":
      "Agenten, die sie haben, können nicht mehr aus ihr antworten. Der Datenspeicher und seine Zeilen bleiben, wie sie sind.",
    "knowledge.empty":
      "Noch keine Wissensbasen. Lege eine für die Tabellen eines Datenspeichers an, zum Beispiel Kunden oder Rechnungen, und gib sie einem Agenten: Er beantwortet dann Fragen aus ihren Zeilen.",
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
    "knowledge.statusOk": "Bereit",
    "knowledge.statusNeedsAttention": "Braucht Aufmerksamkeit",
    "knowledge.statusUnchecked": "Noch nicht geprüft",
    "knowledge.checkedAt": "Zuletzt geprüft",
    "knowledge.checkNow": "Jetzt prüfen",
    "knowledge.checkFailed": "Die Prüfung konnte nicht laufen.",
    "knowledge.tableReadable": "Lesbar",
    "knowledge.tableUnreadable": "Nicht lesbar",
    "knowledge.stateFailed": "Der Status konnte nicht geladen werden.",
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
    "knowledge.agentSection": "Wissen",
    "knowledge.agentSectionDescription":
      "Die Wissensbasen, aus denen dieser Agent antwortet. Er bekommt ein Werkzeug, das alle liest, und sagt in seiner Antwort, welche er genutzt hat.",
    "knowledge.agentNone": "Keine Wissensbasis gewählt.",
    "knowledge.agentChoose": "Wissensbasen wählen",
    "knowledge.agentNote": "Nur eine veröffentlichte Wissensbasis antwortet."
  }
});
