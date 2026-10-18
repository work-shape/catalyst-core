import { defineTranslations } from "./translation-area";

/** Workflows: the bar of a draft, and the question before it is published or discarded. */
export const workflowDraft = defineTranslations({
  en: {
    "workflows.draft.ahead": "Draft differs from published",
    "workflows.draft.aheadBody":
      "You see the draft here. Runs use the published version until the draft is published.",
    "workflows.draft.discard": "Discard",
    "workflows.draft.discardBody":
      "The draft goes back to the published revision {number}. The discarded revisions are kept.",
    "workflows.draft.discardFailed": "The draft could not be discarded.",
    "workflows.draft.discardTitle": "Discard the draft of “{name}”?",
    "workflows.draft.pending":
      "Sent for approval. An instance admin decides in the Inbox; until then the live version stays as it is.",
    "workflows.draft.publish": "Publish",
    "workflows.draft.publishBody": "Revision {number} becomes the version that runs.",
    "workflows.draft.publishBodyBoth":
      "Revision {number} becomes the version that runs, by hand and on its schedule.",
    "workflows.draft.publishBodyByHand":
      "Revision {number} becomes the version that runs when someone starts it.",
    "workflows.draft.publishBodySchedule":
      "Revision {number} becomes the version that runs on its schedule.",
    "workflows.draft.publishFailed": "The draft could not be published.",
    "workflows.draft.publishRaises": "Limits this revision raises",
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
      "Der Entwurf geht auf die veröffentlichte Revision {number} zurück. Die verworfenen Revisionen bleiben erhalten.",
    "workflows.draft.discardFailed": "Der Entwurf konnte nicht verworfen werden.",
    "workflows.draft.discardTitle": "Entwurf von „{name}“ verwerfen?",
    "workflows.draft.pending":
      "Zur Freigabe gesendet. Ein Instanz-Admin entscheidet im Eingang; bis dahin bleibt die live Version, wie sie ist.",
    "workflows.draft.publish": "Veröffentlichen",
    "workflows.draft.publishBody": "Revision {number} wird die Version, die läuft.",
    "workflows.draft.publishBodyBoth":
      "Revision {number} wird die Version, die läuft, von Hand und nach ihrem Zeitplan.",
    "workflows.draft.publishBodyByHand":
      "Revision {number} wird die Version, die läuft, wenn jemand sie startet.",
    "workflows.draft.publishBodySchedule":
      "Revision {number} wird die Version, die nach ihrem Zeitplan läuft.",
    "workflows.draft.publishFailed": "Der Entwurf konnte nicht veröffentlicht werden.",
    "workflows.draft.publishRaises": "Grenzen, die diese Revision anhebt",
    "workflows.draft.publishTitle": "„{name}“ veröffentlichen?",
    "workflows.draft.unpublished": "Entwurf · nicht veröffentlicht",
    "workflows.draft.unpublishedBody":
      "Dieser Workflow hat keine veröffentlichte Version. Er kann gestartet werden, sobald der Entwurf veröffentlicht ist."
  }
});
