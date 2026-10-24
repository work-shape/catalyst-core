import { defineTranslations } from "./translation-area";

// "Einem Agenten geben" (CS-5d): the approved tools of a Connection go to an agent, after the
// approval in the New connection dialog or on the Connection's page, and from the agent's card
// in the conversation.
export const connectionGive = defineTranslations({
  en: {
    "connectionGive.approved": "{count} tools approved.",
    "connectionGive.approvedOne": "1 tool approved.",
    "connectionGive.line": "No agent can use them yet. Give them to the one that should.",
    "connectionGive.open": "Give to an agent",
    "connectionGive.title": "Give to an agent",
    "connectionGive.agentLabel": "Agent",
    "connectionGive.agentHint": "Only agents you may publish are listed.",
    "connectionGive.ownDraft": "Your unpublished draft is open",
    "connectionGive.otherDraftShort": "{name}'s unpublished draft is open",
    "connectionGive.otherDraftShortNoName": "Someone else's unpublished draft is open",
    "connectionGive.loadFailed": "The agents and tools could not be read. Try again.",
    "connectionGive.noTools": "No tool of {connection} is approved for agents yet.",
    "connectionGive.noAgents": "There is no agent you may publish.",
    "connectionGive.next": "Next",
    "connectionGive.retry": "Try again",
    "connectionGive.back": "Back",
    "connectionGive.cancel": "Cancel",
    "connectionGive.question": "Give {agent} {count} tools of {connection}?",
    "connectionGive.questionOne": "Give {agent} 1 tool of {connection}?",
    "connectionGive.publishes":
      "{agent} gets these tools live at once. Every chat with {agent} can use them from its next message.",
    "connectionGive.draftKeeps":
      "{agent} has an unpublished draft. It stays unpublished as it is and gets these tools too.",
    "connectionGive.confirmPublish": "Give tools",
    "connectionGive.openAgent": "Open {agent}",
    "connectionGive.held": "{agent} has these tools already.",
    "connectionGive.published": "{agent} can use the tools of {connection} from the next message.",
    "connectionGive.waits": "The change to {agent} waits for an approval in the Inbox.",
    "connectionGive.changed":
      "{agent} was changed in the meantime. Nothing was given: go back and try again.",
    "connectionGive.failed": "The tools could not be given. Try again.",
    "connectionGive.done": "Done",
    "connectionGive.cardTitle": "Tools of {connection} for an agent",
    "connectionGive.cardMeta": "{count} tools for agents",
    "connectionGive.cardMetaOne": "1 tool for agents",
    "connectionGive.cardNote": "Nothing changes before you confirm.",
    "connectionGive.cardNone": "No tool of this connection is approved for agents.",
    "connectionGive.cardFailed": "The connection could not be read. Try again.",
    "connectionGive.cardGiven": "Given to {agent}.",
    "connectionGive.told":
      "{agent} ({agentName}) now has {count} tools of {title} ({name}): {tools}.",
    "connectionGive.toldOne": "{agent} ({agentName}) now has 1 tool of {title} ({name}): {tools}."
  },
  de: {
    "connectionGive.approved": "{count} Tools freigegeben.",
    "connectionGive.approvedOne": "1 Tool freigegeben.",
    "connectionGive.line":
      "Noch kann kein Agent sie nutzen. Gib sie dem Agenten, der sie nutzen soll.",
    "connectionGive.open": "Einem Agenten geben",
    "connectionGive.title": "Einem Agenten geben",
    "connectionGive.agentLabel": "Agent",
    "connectionGive.agentHint": "Hier stehen nur Agenten, die du veröffentlichen darfst.",
    "connectionGive.ownDraft": "Dein unveröffentlichter Entwurf ist offen",
    "connectionGive.otherDraftShort": "Unveröffentlichter Entwurf von {name} ist offen",
    "connectionGive.otherDraftShortNoName":
      "Ein unveröffentlichter Entwurf von jemand anderem ist offen",
    "connectionGive.loadFailed":
      "Die Agenten und Tools konnten nicht gelesen werden. Versuch es noch einmal.",
    "connectionGive.noTools": "Von {connection} ist noch kein Tool für Agenten freigegeben.",
    "connectionGive.noAgents": "Es gibt keinen Agenten, den du veröffentlichen darfst.",
    "connectionGive.next": "Weiter",
    "connectionGive.retry": "Erneut versuchen",
    "connectionGive.back": "Zurück",
    "connectionGive.cancel": "Abbrechen",
    "connectionGive.question": "{agent} {count} Tools von {connection} geben?",
    "connectionGive.questionOne": "{agent} 1 Tool von {connection} geben?",
    "connectionGive.publishes":
      "{agent} bekommt diese Tools sofort live. Jeder Chat mit {agent} kann sie ab der nächsten Nachricht nutzen.",
    "connectionGive.draftKeeps":
      "{agent} hat einen unveröffentlichten Entwurf. Er bleibt unveröffentlicht, wie er ist, und bekommt diese Tools auch.",
    "connectionGive.confirmPublish": "Tools geben",
    "connectionGive.openAgent": "{agent} öffnen",
    "connectionGive.held": "{agent} hat diese Tools schon.",
    "connectionGive.published":
      "{agent} kann die Tools von {connection} ab der nächsten Nachricht nutzen.",
    "connectionGive.waits": "Die Änderung an {agent} wartet auf eine Freigabe im Eingang.",
    "connectionGive.changed":
      "{agent} wurde inzwischen geändert. Es wurde nichts vergeben: Geh zurück und versuch es noch einmal.",
    "connectionGive.failed": "Die Tools konnten nicht vergeben werden. Versuch es noch einmal.",
    "connectionGive.done": "Fertig",
    "connectionGive.cardTitle": "Tools von {connection} für einen Agenten",
    "connectionGive.cardMeta": "{count} Tools für Agenten",
    "connectionGive.cardMetaOne": "1 Tool für Agenten",
    "connectionGive.cardNote": "Geändert wird erst, wenn du bestätigst.",
    "connectionGive.cardNone": "Von dieser Verbindung ist kein Tool für Agenten freigegeben.",
    "connectionGive.cardFailed":
      "Die Verbindung konnte nicht gelesen werden. Versuch es noch einmal.",
    "connectionGive.cardGiven": "An {agent} gegeben.",
    "connectionGive.told":
      "{agent} ({agentName}) hat jetzt {count} Werkzeuge von {title} ({name}): {tools}.",
    "connectionGive.toldOne":
      "{agent} ({agentName}) hat jetzt 1 Werkzeug von {title} ({name}): {tools}."
  }
});
