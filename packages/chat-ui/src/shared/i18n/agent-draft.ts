import { defineTranslations } from "./translation-area";

/**
 * The agent's one draft on its page: the badge that names it, Save draft, Publish and Discard,
 * and the published value beside each field the draft changes.
 */
export const agentDraft = defineTranslations({
  en: {
    "agentDraft.authorRelease": "The team that runs this instance",
    "agentDraft.authorUnknown": "A former member",
    "agentDraft.authorWithAgent": "{name} with the agent",
    "agentDraft.badge": "Draft version {revision}",
    "agentDraft.behind":
      "{author} saved draft version {revision} on {time}, while you were editing. Your text is still here and nothing was overwritten, but it can no longer be saved. Loading the newer draft replaces your text, so copy what you want to keep first.",
    "agentDraft.behindRelease":
      "The team that runs this instance saved draft version {revision} on {time}, while you were editing. Your text is still here and nothing was overwritten, but it can no longer be saved. Loading the newer draft replaces your text, so copy what you want to keep first.",
    "agentDraft.changed":
      "Someone saved a newer draft while you were looking at it. It is shown now: read it before you publish.",
    "agentDraft.discard": "Discard draft",
    "agentDraft.discardDescription":
      "Draft version {revision} is removed. The published version stays as it is.",
    "agentDraft.discardTitle": "Discard the draft of {name}?",
    "agentDraft.empty": "Empty",
    "agentDraft.failed": "That did not work. Try again.",
    "agentDraft.gone":
      "Someone published or discarded the draft while you were editing. Your text is still here, but it can no longer be saved. Load the agent to go on from what is published.",
    "agentDraft.label": "Published",
    "agentDraft.loadAgent": "Load the agent",
    "agentDraft.loadDraft": "Load the newer draft",
    "agentDraft.none": "None",
    "agentDraft.off": "Off",
    "agentDraft.on": "On",
    "agentDraft.pending":
      "{author} saved draft version {revision} on {time}. It is not live: everyone who uses “{name}” gets the published version until the draft is published.",
    "agentDraft.pendingRelease":
      "The team that runs this instance saved draft version {revision} on {time}. It is not live: everyone who uses “{name}” gets the published version until the draft is published.",
    "agentDraft.publishDescription":
      "Draft version {revision} becomes what everyone who uses “{name}” gets, from now on.",
    "agentDraft.publishNeedsRight": "Publishing needs the right “{right}”.",
    "agentDraft.saveDraft": "Save draft",
    "agentDraft.saveHint":
      "Saves a draft. People who use the agent get the published version until it is published.",
    "agentDraft.sectionMark": "Changed in the draft",
    "agentDraft.shippedBadge": "Ships with the platform",
    "agentDraft.shippedDiffers": "Differs from what the platform ships",
    "agentDraft.shippedReset": "Reset to shipped",
    "agentDraft.stale":
      "The published version of “{name}” changed after this draft was written, so the draft cannot be published. Save a change to base it on the published version, or discard it."
  },
  de: {
    "agentDraft.authorRelease": "Das Team, das diese Instanz betreibt",
    "agentDraft.authorUnknown": "Ein ehemaliges Mitglied",
    "agentDraft.authorWithAgent": "{name} mit dem Agenten",
    "agentDraft.badge": "Entwurfsversion {revision}",
    "agentDraft.behind":
      "{author} hat am {time} Entwurfsversion {revision} gespeichert, während du bearbeitet hast. Dein Text ist noch da und nichts wurde überschrieben, aber er lässt sich nicht mehr speichern. Den neueren Entwurf zu laden ersetzt deinen Text. Kopiere vorher, was du behalten willst.",
    "agentDraft.behindRelease":
      "Das Team, das diese Instanz betreibt, hat am {time} Entwurfsversion {revision} gespeichert, während du bearbeitet hast. Dein Text ist noch da und nichts wurde überschrieben, aber er lässt sich nicht mehr speichern. Den neueren Entwurf zu laden ersetzt deinen Text. Kopiere vorher, was du behalten willst.",
    "agentDraft.changed":
      "Jemand hat einen neueren Entwurf gespeichert, während du ihn angesehen hast. Er wird jetzt gezeigt: Lies ihn, bevor du veröffentlichst.",
    "agentDraft.discard": "Entwurf verwerfen",
    "agentDraft.discardDescription":
      "Entwurfsversion {revision} wird entfernt. Die veröffentlichte Version bleibt, wie sie ist.",
    "agentDraft.discardTitle": "Den Entwurf von {name} verwerfen?",
    "agentDraft.empty": "Leer",
    "agentDraft.failed": "Das hat nicht geklappt. Versuch es noch einmal.",
    "agentDraft.gone":
      "Jemand hat den Entwurf veröffentlicht oder verworfen, während du bearbeitet hast. Dein Text steht noch hier, lässt sich aber nicht mehr speichern. Lade den Agenten, um von der veröffentlichten Version aus weiterzumachen.",
    "agentDraft.label": "Veröffentlicht",
    "agentDraft.loadAgent": "Agenten laden",
    "agentDraft.loadDraft": "Neueren Entwurf laden",
    "agentDraft.none": "Keine",
    "agentDraft.off": "Aus",
    "agentDraft.on": "An",
    "agentDraft.pending":
      "{author} hat am {time} Entwurfsversion {revision} gespeichert. Sie ist nicht live: Alle, die „{name}“ nutzen, bekommen die veröffentlichte Version, bis der Entwurf veröffentlicht ist.",
    "agentDraft.pendingRelease":
      "Das Team, das diese Instanz betreibt, hat am {time} Entwurfsversion {revision} gespeichert. Sie ist nicht live: Alle, die „{name}“ nutzen, bekommen die veröffentlichte Version, bis der Entwurf veröffentlicht ist.",
    "agentDraft.publishDescription":
      "Entwurfsversion {revision} wird ab jetzt die Version, die alle bekommen, die „{name}“ nutzen.",
    "agentDraft.publishNeedsRight": "Veröffentlichen braucht das Recht „{right}“.",
    "agentDraft.saveDraft": "Entwurf speichern",
    "agentDraft.saveHint":
      "Speichert einen Entwurf. Wer den Agenten nutzt, bekommt die veröffentlichte Version, bis er veröffentlicht ist.",
    "agentDraft.sectionMark": "Im Entwurf geändert",
    "agentDraft.shippedBadge": "Kommt mit der Plattform",
    "agentDraft.shippedDiffers": "Weicht von dem ab, was die Plattform mitbringt",
    "agentDraft.shippedReset": "Auf Auslieferung zurücksetzen",
    "agentDraft.stale":
      "Die veröffentlichte Version von „{name}“ hat sich geändert, nachdem dieser Entwurf geschrieben wurde. Darum lässt er sich nicht veröffentlichen. Speichere eine Änderung, um ihn auf die veröffentlichte Version zu stützen, oder verwirf ihn."
  }
});
