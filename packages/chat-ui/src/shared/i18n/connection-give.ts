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
      "This publishes {agent} with these tools added. Every chat with {agent} can use them from its next message.",
    "connectionGive.ownDraftNotice":
      "You have an unpublished draft of {agent}. The tools are added to it.",
    "connectionGive.publishDraft": "Publish the whole draft now",
    "connectionGive.publishDraftHint": "Your other changes in the draft are published with them.",
    "connectionGive.confirmPublish": "Give and publish",
    "connectionGive.confirmDraft": "Add to draft",
    "connectionGive.otherDraft":
      "{author} has an unpublished draft of {agent}. Nothing was changed: the draft is theirs to publish or discard first.",
    "connectionGive.otherDraftNoName":
      "Someone else has an unpublished draft of {agent}. Nothing was changed: the draft is theirs to publish or discard first.",
    "connectionGive.staleDraft":
      "Your unpublished draft of {agent} is based on an older published version. Nothing was changed: open {agent} to bring the draft up to date or discard it first.",
    "connectionGive.openAgent": "Open {agent}",
    "connectionGive.held": "{agent} has these tools already.",
    "connectionGive.heldDraft": "Your draft of {agent} has these tools already.",
    "connectionGive.published": "{agent} can use the tools of {connection} from the next message.",
    "connectionGive.drafted":
      "The tools are in your draft of {agent}. They work once you publish the draft.",
    "connectionGive.waits": "The change to {agent} waits for an approval in the Inbox.",
    "connectionGive.failed": "The tools could not be given. Try again.",
    "connectionGive.done": "Done",
    "connectionGive.cardTitle": "Tools of {connection} for an agent",
    "connectionGive.cardMeta": "{count} tools for agents",
    "connectionGive.cardMetaOne": "1 tool for agents",
    "connectionGive.cardNote": "Nothing changes before you confirm.",
    "connectionGive.cardNone": "No tool of this connection is approved for agents.",
    "connectionGive.cardFailed": "The connection could not be read. Try again.",
    "connectionGive.cardGiven": "Given to {agent}."
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
      "Damit wird {agent} mit diesen Tools veröffentlicht. Jeder Chat mit {agent} kann sie ab der nächsten Nachricht nutzen.",
    "connectionGive.ownDraftNotice":
      "Du hast einen unveröffentlichten Entwurf von {agent}. Die Tools kommen in diesen Entwurf.",
    "connectionGive.publishDraft": "Den ganzen Entwurf jetzt veröffentlichen",
    "connectionGive.publishDraftHint":
      "Deine anderen Änderungen im Entwurf werden mit veröffentlicht.",
    "connectionGive.confirmPublish": "Geben und veröffentlichen",
    "connectionGive.confirmDraft": "Zum Entwurf hinzufügen",
    "connectionGive.otherDraft":
      "{author} hat einen unveröffentlichten Entwurf von {agent}. Es wurde nichts geändert: Den Entwurf veröffentlicht oder verwirft zuerst {author}.",
    "connectionGive.otherDraftNoName":
      "Jemand anderes hat einen unveröffentlichten Entwurf von {agent}. Es wurde nichts geändert: Der Entwurf muss zuerst veröffentlicht oder verworfen werden.",
    "connectionGive.staleDraft":
      "Dein unveröffentlichter Entwurf von {agent} beruht auf einer älteren veröffentlichten Version. Es wurde nichts geändert: Öffne {agent} und bring den Entwurf zuerst auf den neuen Stand oder verwirf ihn.",
    "connectionGive.openAgent": "{agent} öffnen",
    "connectionGive.held": "{agent} hat diese Tools schon.",
    "connectionGive.heldDraft": "Dein Entwurf von {agent} hat diese Tools schon.",
    "connectionGive.published":
      "{agent} kann die Tools von {connection} ab der nächsten Nachricht nutzen.",
    "connectionGive.drafted":
      "Die Tools sind in deinem Entwurf von {agent}. Sie wirken, sobald du den Entwurf veröffentlichst.",
    "connectionGive.waits": "Die Änderung an {agent} wartet auf eine Freigabe im Eingang.",
    "connectionGive.failed": "Die Tools konnten nicht vergeben werden. Versuch es noch einmal.",
    "connectionGive.done": "Fertig",
    "connectionGive.cardTitle": "Tools von {connection} für einen Agenten",
    "connectionGive.cardMeta": "{count} Tools für Agenten",
    "connectionGive.cardMetaOne": "1 Tool für Agenten",
    "connectionGive.cardNote": "Geändert wird erst, wenn du bestätigst.",
    "connectionGive.cardNone": "Von dieser Verbindung ist kein Tool für Agenten freigegeben.",
    "connectionGive.cardFailed":
      "Die Verbindung konnte nicht gelesen werden. Versuch es noch einmal.",
    "connectionGive.cardGiven": "An {agent} gegeben."
  }
});
