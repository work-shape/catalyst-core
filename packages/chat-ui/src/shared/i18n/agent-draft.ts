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
    "agentDraft.goneSkill":
      "Someone published or discarded the draft while you were editing. Your text is still here, but it can no longer be saved. Load the skill to go on from what is published.",
    "agentDraft.label": "Published",
    "agentDraft.loadAgent": "Load the agent",
    "agentDraft.loadSkill": "Load the skill",
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
    "agentDraft.publishDescriptionSkill":
      "Draft version {revision} becomes what every agent that uses “{name}” reads, from now on.",
    "agentDraft.publishNeedsRight": "Publishing needs the right “{right}”.",
    "agentDraft.saveDraft": "Save draft",
    "agentDraft.saveHint":
      "Saves a draft. People who use the agent get the published version until it is published.",
    "agentDraft.saveHintSkill":
      "Saves a draft. Every agent that uses the skill gets the published version until the draft is published.",
    "agentDraft.sectionMark": "Changed in the draft",
    "agentDraft.shippedBadge": "Ships with the platform",
    "agentDraft.shippedDiffers": "Differs from what the platform ships",
    "agentDraft.shippedReset": "Reset to shipped",
    "agentDraft.shippedNewer": "The platform has a new version of this field.",
    "agentDraft.shippedNewerMine": "Your version",
    "agentDraft.shippedNewerNext": "New version of the platform",
    "agentDraft.shippedTakeNewer": "Take new version",
    "agentDraft.shippedKeepMine": "Keep mine",
    "agentDraft.platformInstructions": "Platform instructions",
    "agentDraft.platformInstructionsHint":
      "Ship with the platform and take each release's new version.",
    "agentDraft.platformInstructionsEdit": "Change platform text",
    "agentDraft.platformInstructionsEditHint":
      "Once you change it, this text is the instance's and no release updates it.",
    "agentDraft.additionalInstructions": "Additions of this instance",
    "agentDraft.additionalInstructionsHint":
      "Apply after the platform's instructions. A release never changes them.",
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
    "agentDraft.goneSkill":
      "Jemand hat den Entwurf veröffentlicht oder verworfen, während du bearbeitet hast. Dein Text steht noch hier, lässt sich aber nicht mehr speichern. Lade den Skill, um von der veröffentlichten Version aus weiterzumachen.",
    "agentDraft.label": "Veröffentlicht",
    "agentDraft.loadAgent": "Agenten laden",
    "agentDraft.loadSkill": "Skill laden",
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
    "agentDraft.publishDescriptionSkill":
      "Entwurfsversion {revision} wird ab jetzt die Version, die jeder Agent liest, der „{name}“ nutzt.",
    "agentDraft.publishNeedsRight": "Veröffentlichen braucht das Recht „{right}“.",
    "agentDraft.saveDraft": "Entwurf speichern",
    "agentDraft.saveHint":
      "Speichert einen Entwurf. Wer den Agenten nutzt, bekommt die veröffentlichte Version, bis er veröffentlicht ist.",
    "agentDraft.saveHintSkill":
      "Speichert einen Entwurf. Jeder Agent, der den Skill nutzt, bekommt die veröffentlichte Version, bis der Entwurf veröffentlicht ist.",
    "agentDraft.sectionMark": "Im Entwurf geändert",
    "agentDraft.shippedBadge": "Kommt mit der Plattform",
    "agentDraft.shippedDiffers": "Weicht von dem ab, was die Plattform mitbringt",
    "agentDraft.shippedReset": "Auf Auslieferung zurücksetzen",
    "agentDraft.shippedNewer": "Die Plattform hat eine neue Fassung dieses Felds.",
    "agentDraft.shippedNewerMine": "Deine Fassung",
    "agentDraft.shippedNewerNext": "Neue Fassung der Plattform",
    "agentDraft.shippedTakeNewer": "Neue Fassung übernehmen",
    "agentDraft.shippedKeepMine": "Meine behalten",
    "agentDraft.platformInstructions": "Anweisungen der Plattform",
    "agentDraft.platformInstructionsHint":
      "Kommen mit der Plattform und übernehmen mit jedem Release die neue Fassung.",
    "agentDraft.platformInstructionsEdit": "Plattform-Text ändern",
    "agentDraft.platformInstructionsEditHint":
      "Sobald du ihn änderst, gehört dieser Text der Instanz, und kein Release aktualisiert ihn mehr.",
    "agentDraft.additionalInstructions": "Ergänzungen dieser Instanz",
    "agentDraft.additionalInstructionsHint":
      "Gelten nach den Anweisungen der Plattform. Ein Release ändert sie nie.",
    "agentDraft.stale":
      "Die veröffentlichte Version von „{name}“ hat sich geändert, nachdem dieser Entwurf geschrieben wurde. Darum lässt er sich nicht veröffentlichen. Speichere eine Änderung, um ihn auf die veröffentlichte Version zu stützen, oder verwirf ihn."
  }
});
