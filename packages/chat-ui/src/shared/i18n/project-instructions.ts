import { defineTranslations } from "./translation-area";

/**
 * The instructions of a project (PRJ-3): its `AGENTS.md` as the tile on the project's page, the
 * panel that shows and edits it, the card on which a person allows the agent's change, and the
 * line in a chat whose project's instructions changed since its last run.
 */
export const projectInstructions = defineTranslations({
  en: {
    "projectInstructions.title": "Instructions",
    "projectInstructions.tileEmpty":
      "No instructions yet. Write what the agent should know in every chat of this project.",
    "projectInstructions.tileMeta": "AGENTS.md · {person} · {when}",
    "projectInstructions.tileMetaFormer": "AGENTS.md · former member · {when}",
    "projectInstructions.open": "Open the instructions",
    "projectInstructions.write": "Write instructions",
    "projectInstructions.panelLead":
      "Every chat in {project} follows these instructions, after the agent's own. They add facts and preferences; they grant no rights.",
    "projectInstructions.truncated":
      "These instructions are longer than {max} characters. A chat takes only the first {max}.",
    "projectInstructions.edit": "Edit",
    "projectInstructions.save": "Save",
    "projectInstructions.cancel": "Cancel",
    "projectInstructions.field": "Instructions",
    "projectInstructions.fieldHint": "Plain text or Markdown. Chats take it from their next turn.",
    "projectInstructions.saveFailed": "The instructions could not be saved.",
    "projectInstructions.changedMeanwhile":
      "Someone changed the instructions meanwhile. Copy your text, close and open them again.",
    "projectInstructions.loadFailed": "The instructions could not be loaded.",
    "projectInstructions.versions": "Versions",
    "projectInstructions.decisionTitle": "Change the project's instructions",
    "projectInstructions.decisionAudience": "Everyone in {project} follows this.",
    "projectInstructions.decisionNew": "The instructions start with this text.",
    "projectInstructions.decisionUnreadable":
      "The change could not be shown against the current instructions. Its input is under Details.",
    "projectInstructions.before": "Before",
    "projectInstructions.after": "New",
    "projectInstructions.removed": "Removed",
    "projectInstructions.noChange": "The text stays as it is.",
    "projectInstructions.changedNotice": "The project's instructions changed.",
    "projectInstructions.showChanges": "Show changes",
    "projectInstructions.changesTitle": "What changed in the instructions",
    "projectInstructions.changesLead":
      "From version {from} to version {to}. The next answer in this chat follows the new version.",
    "projectInstructions.changesLeadNew":
      "The project has instructions now. The next answer in this chat follows them.",
    "projectInstructions.changesLeadRemoved":
      "The project's instructions were deleted. The next answer in this chat follows none.",
    "projectInstructions.close": "Close"
  },
  de: {
    "projectInstructions.title": "Anweisungen",
    "projectInstructions.tileEmpty":
      "Noch keine Anweisungen. Schreib, was der Agent in jedem Chat dieses Projekts wissen soll.",
    "projectInstructions.tileMeta": "AGENTS.md · {person} · {when}",
    "projectInstructions.tileMetaFormer": "AGENTS.md · ehemaliges Mitglied · {when}",
    "projectInstructions.open": "Anweisungen öffnen",
    "projectInstructions.write": "Anweisungen schreiben",
    "projectInstructions.panelLead":
      "Jeder Chat in {project} folgt diesen Anweisungen, nach denen des Agenten. Sie ergänzen Fakten und Vorlieben; Rechte geben sie keine.",
    "projectInstructions.truncated":
      "Diese Anweisungen sind länger als {max} Zeichen. Ein Chat liest nur die ersten {max}.",
    "projectInstructions.edit": "Bearbeiten",
    "projectInstructions.save": "Speichern",
    "projectInstructions.cancel": "Abbrechen",
    "projectInstructions.field": "Anweisungen",
    "projectInstructions.fieldHint":
      "Text oder Markdown. Chats lesen sie ab ihrer nächsten Antwort.",
    "projectInstructions.saveFailed": "Die Anweisungen konnten nicht gespeichert werden.",
    "projectInstructions.changedMeanwhile":
      "Jemand hat die Anweisungen inzwischen geändert. Kopier deinen Text, schließ sie und öffne sie neu.",
    "projectInstructions.loadFailed": "Die Anweisungen konnten nicht geladen werden.",
    "projectInstructions.versions": "Versionen",
    "projectInstructions.decisionTitle": "Anweisungen des Projekts ändern",
    "projectInstructions.decisionAudience": "Alle in {project} arbeiten danach.",
    "projectInstructions.decisionNew": "Die Anweisungen beginnen mit diesem Text.",
    "projectInstructions.decisionUnreadable":
      "Die Änderung ließ sich nicht gegen die aktuellen Anweisungen zeigen. Die Eingabe steht unter Details.",
    "projectInstructions.before": "Bisher",
    "projectInstructions.after": "Neu",
    "projectInstructions.removed": "Entfernt",
    "projectInstructions.noChange": "Der Text bleibt, wie er ist.",
    "projectInstructions.changedNotice": "Die Anweisungen des Projekts haben sich geändert.",
    "projectInstructions.showChanges": "Änderungen anzeigen",
    "projectInstructions.changesTitle": "Was sich an den Anweisungen geändert hat",
    "projectInstructions.changesLead":
      "Von Version {from} zu Version {to}. Die nächste Antwort in diesem Chat folgt der neuen Version.",
    "projectInstructions.changesLeadNew":
      "Das Projekt hat jetzt Anweisungen. Die nächste Antwort in diesem Chat folgt ihnen.",
    "projectInstructions.changesLeadRemoved":
      "Die Anweisungen des Projekts wurden gelöscht. Die nächste Antwort in diesem Chat folgt keinen.",
    "projectInstructions.close": "Schließen"
  }
});
