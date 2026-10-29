import { defineTranslations } from "./translation-area";

/** Workflows: the bar of a draft, and the question before it is published or discarded. */
export const workflowDraft = defineTranslations({
  en: {
    "workflows.draft.ahead": "Draft differs from published",
    "workflows.draft.aheadBody":
      "You see the draft here. Runs use the published version until the draft is published.",
    "workflows.draft.discard": "Discard",
    "workflows.draft.discardBody":
      "The draft goes back to the published version {number}. The discarded versions are kept.",
    "workflows.draft.discardFailed": "The draft could not be discarded.",
    "workflows.draft.discardTitle": "Discard the draft of “{name}”?",
    "workflows.draft.pending":
      "Sent for approval. An admin for all workspaces decides in the Inbox; until then the live version stays as it is.",
    "workflows.draft.publish": "Publish",
    "workflows.draft.publishBody": "Version {number} becomes the one that runs.",
    "workflows.draft.publishBodyBoth":
      "Version {number} becomes the one that runs, by hand and on its schedule.",
    "workflows.draft.publishBodyByHand":
      "Version {number} becomes the one that runs when someone starts it.",
    "workflows.draft.publishBodySchedule":
      "Version {number} becomes the one that runs on its schedule.",
    "workflows.draft.publishFailed": "The draft could not be published.",
    "workflows.draft.publishChanges": "What this publish changes",
    "workflows.draft.publishStore": "Publishes the data store “{title}” first.",
    "workflows.draft.publishStoreMigrationOne":
      "Publishes the data store “{title}” first and applies 1 change to its tables: {migrations}.",
    "workflows.draft.publishStoreMigrations":
      "Publishes the data store “{title}” first and applies {count} changes to its tables: {migrations}.",
    "workflows.draft.publishTitle": "Publish “{name}”?",
    "workflows.draft.unpublished": "Draft · not published",
    "workflows.draft.unpublishedBody":
      "This workflow has no published version. It can be started once the draft is published."
  },
  de: {
    "workflows.draft.ahead": "Entwurf weicht von der veröffentlichten Version ab",
    "workflows.draft.aheadBody":
      "Du siehst hier den Entwurf. Läufe nutzen die veröffentlichte Version, bis der Entwurf veröffentlicht ist.",
    "workflows.draft.discard": "Verwerfen",
    "workflows.draft.discardBody":
      "Der Entwurf geht auf die veröffentlichte Version {number} zurück. Die verworfenen Versionen bleiben erhalten.",
    "workflows.draft.discardFailed": "Der Entwurf konnte nicht verworfen werden.",
    "workflows.draft.discardTitle": "Entwurf von „{name}“ verwerfen?",
    "workflows.draft.pending":
      "Zur Freigabe gesendet. Ein Admin für alle Arbeitsbereiche entscheidet im Eingang; bis dahin bleibt die live Version, wie sie ist.",
    "workflows.draft.publish": "Veröffentlichen",
    "workflows.draft.publishBody": "Version {number} wird die, die läuft.",
    "workflows.draft.publishBodyBoth":
      "Version {number} wird die, die läuft, von Hand und nach ihrem Zeitplan.",
    "workflows.draft.publishBodyByHand":
      "Version {number} wird die, die läuft, wenn jemand sie startet.",
    "workflows.draft.publishBodySchedule":
      "Version {number} wird die, die nach ihrem Zeitplan läuft.",
    "workflows.draft.publishFailed": "Der Entwurf konnte nicht veröffentlicht werden.",
    "workflows.draft.publishChanges": "Was diese Veröffentlichung ändert",
    "workflows.draft.publishStore": "Veröffentlicht zuerst den Datenspeicher „{title}“.",
    "workflows.draft.publishStoreMigrationOne":
      "Veröffentlicht zuerst den Datenspeicher „{title}“ und wendet 1 Änderung an seinen Tabellen an: {migrations}.",
    "workflows.draft.publishStoreMigrations":
      "Veröffentlicht zuerst den Datenspeicher „{title}“ und wendet {count} Änderungen an seinen Tabellen an: {migrations}.",
    "workflows.draft.publishTitle": "„{name}“ veröffentlichen?",
    "workflows.draft.unpublished": "Entwurf · nicht veröffentlicht",
    "workflows.draft.unpublishedBody":
      "Dieser Workflow hat keine veröffentlichte Version. Er kann gestartet werden, sobald der Entwurf veröffentlicht ist."
  }
});
