import { defineTranslations } from "./translation-area";

// One private chat shared with named people (CHAT-SHARE-2), members of its workspace or anyone
// active on the instance (CHAT-SHARE-6): the @ menu in the composer, the chips and the lines
// above it, who sees the chat in its head, the rail's mark and the Inbox notice, and what an
// outside reader's composer says of their agent. The refusals are worded by their reason, one
// sentence each.
export const chatShare = defineTranslations({
  en: {
    "chatShare.menuLabel": "People to share this chat with",
    "chatShare.menuHeading": "Share this chat with",
    "chatShare.hasAccess": "has access",
    "chatShare.noMatch": "Nobody matches. To find someone by email, type the whole address.",
    "chatShare.oneMoreLetter": "Type one more letter to search everyone.",
    "chatShare.searchLimited": "Too many searches. Wait a moment.",
    "chatShare.notIn": "not in {workspace}",
    "chatShare.noCandidates":
      "Nobody to offer yet. People you work with in {workspace} show up here.",
    "chatShare.loadFailed": "The people could not be loaded. Type @ again to retry.",
    "chatShare.chipsLabel": "Shared when you send",
    "chatShare.willSee": "{names} will see the whole chat, files included, and can write in it.",
    "chatShare.ownStop": "Your own skills and Connections stop working in this chat.",
    "chatShare.outsideOne":
      "{name} is not in {workspace}: they see only this chat, and their turns run with their own rights.",
    "chatShare.outsideMany":
      "{names} are not in {workspace}: they see only this chat, and their turns run with their own rights.",
    "chatShare.sharing": "Sharing the chat…",
    "chatShare.removeChipFirst": "Remove the person first: the chat cannot be shared with them.",
    "chatShare.and": "{first} and {last}",
    "chatShare.share": "Share",
    "chatShare.menuItem": "Share…",
    "chatShare.shareLabel": "Share this chat",
    "chatShare.peopleLabel": "Who can see this chat: {names}",
    "chatShare.panelTitle": "Who can see this chat",
    "chatShare.panelOnlyYou": "Only you see this chat.",
    "chatShare.startedChat": "Started the chat",
    "chatShare.named": "Can read and write",
    "chatShare.you": "{name} (you)",
    "chatShare.remove": "Remove",
    "chatShare.removeLabel": "Remove {name}",
    "chatShare.leave": "Leave",
    "chatShare.leaveTitle": "Leave this chat?",
    "chatShare.leaveBody": "You will no longer see “{title}”. Your messages stay in it.",
    "chatShare.leaveConfirm": "Leave chat",
    "chatShare.addPerson": "Add person",
    "chatShare.search": "Name or email",
    "chatShare.addNote":
      "Whoever you add sees the whole chat, files included, and can write in it.",
    "chatShare.deletedWithAccount": "This chat is deleted with {name}’s account.",
    "chatShare.close": "Close",
    "chatShare.sharedWith": "Shared with {names}",
    "chatShare.senderYou": "You",
    "chatShare.someone": "Someone",
    "chatShare.openChat": "Open chat",
    "chatShare.outsideChipLabel": "This chat is in {workspace}. You see nothing else of it.",
    "chatShare.outsideAgent":
      "{workspace}’s own agent works only for its members. Your turns use {agent}.",
    "chatShare.outsideNoAgent":
      "No agent here is open to you. You can read this chat, and {creator} can continue it.",
    "chatShare.refusal.personal_conversation_private":
      "This chat used something only you can use (your mail, your own skill or agent). It stays yours. Start a new chat to work on it together.",
    "chatShare.refusal.data_store_conversation_private":
      "This chat reads the Data Store “{store}”, which {name} may not read. It stays yours.",
    "chatShare.refusal.subject_conversation_private":
      "This chat works on a draft that only someone who may change it reads ({right}). {name} may not.",
    "chatShare.refusal.conversation_in_project":
      "This chat is in a project. Share the project instead.",
    "chatShare.refusal.personal_workspace_conversation":
      "Personal chats stay yours. Move this chat to a team to share it.",
    "chatShare.refusal.conversation_not_shareable":
      "Only a private chat in a team, outside any project, is shared with single people.",
    "chatShare.refusal.share_creator_only":
      "Only the person who started this chat chooses who sees it.",
    "chatShare.refusal.share_first_party_only":
      "Only you, signed in yourself, change who sees a chat.",
    "chatShare.refusal.share_person_unavailable": "{name} cannot be added.",
    "chatShare.refusal.share_people_limit":
      "A chat is shared with 20 people at most. For more, make it a team chat or a project.",
    "chatShare.refusal.share_checks_changed": "The chat changed meanwhile. Try again.",
    "chatShare.refusal.person_run_active":
      "{name} has a turn going in this chat. Try again once it ends."
  },
  de: {
    "chatShare.menuLabel": "Personen, mit denen du diesen Chat teilst",
    "chatShare.menuHeading": "Diesen Chat teilen mit",
    "chatShare.hasAccess": "hat Zugriff",
    "chatShare.noMatch":
      "Niemand passt. Um jemanden per E-Mail zu finden, tippe die ganze Adresse.",
    "chatShare.oneMoreLetter": "Tippe einen Buchstaben mehr, um alle zu durchsuchen.",
    "chatShare.searchLimited": "Zu viele Suchen. Warte einen Moment.",
    "chatShare.notIn": "nicht in {workspace}",
    "chatShare.noCandidates":
      "Noch niemand zum Anbieten. Personen, mit denen du in {workspace} arbeitest, erscheinen hier.",
    "chatShare.loadFailed":
      "Die Personen konnten nicht geladen werden. Tippe @ noch einmal, um es erneut zu versuchen.",
    "chatShare.chipsLabel": "Wird beim Senden geteilt",
    "chatShare.willSee":
      "{names} sieht den ganzen Chat, auch die Dateien, und kann darin schreiben.",
    "chatShare.ownStop":
      "Deine eigenen Skills und Verbindungen funktionieren in diesem Chat nicht mehr.",
    "chatShare.outsideOne":
      "{name} ist nicht in {workspace}: {name} sieht nur diesen Chat, und was {name} schreibt, läuft mit eigenen Rechten.",
    "chatShare.outsideMany":
      "{names} sind nicht in {workspace}: sie sehen nur diesen Chat, und was sie schreiben, läuft mit ihren eigenen Rechten.",
    "chatShare.sharing": "Chat wird geteilt…",
    "chatShare.removeChipFirst":
      "Entferne die Person zuerst: Der Chat lässt sich nicht mit ihr teilen.",
    "chatShare.and": "{first} und {last}",
    "chatShare.share": "Teilen",
    "chatShare.menuItem": "Teilen…",
    "chatShare.shareLabel": "Diesen Chat teilen",
    "chatShare.peopleLabel": "Wer diesen Chat sieht: {names}",
    "chatShare.panelTitle": "Wer diesen Chat sieht",
    "chatShare.panelOnlyYou": "Nur du siehst diesen Chat.",
    "chatShare.startedChat": "Hat den Chat begonnen",
    "chatShare.named": "Kann lesen und schreiben",
    "chatShare.you": "{name} (du)",
    "chatShare.remove": "Entfernen",
    "chatShare.removeLabel": "{name} entfernen",
    "chatShare.leave": "Verlassen",
    "chatShare.leaveTitle": "Diesen Chat verlassen?",
    "chatShare.leaveBody":
      "Du siehst „{title}“ danach nicht mehr. Deine Nachrichten bleiben darin.",
    "chatShare.leaveConfirm": "Chat verlassen",
    "chatShare.addPerson": "Person hinzufügen",
    "chatShare.search": "Name oder E-Mail",
    "chatShare.addNote":
      "Wen du hinzufügst, sieht den ganzen Chat, auch die Dateien, und kann darin schreiben.",
    "chatShare.deletedWithAccount": "Dieser Chat wird mit dem Konto von {name} gelöscht.",
    "chatShare.close": "Schließen",
    "chatShare.sharedWith": "Geteilt mit {names}",
    "chatShare.senderYou": "Du",
    "chatShare.someone": "Jemand",
    "chatShare.openChat": "Chat öffnen",
    "chatShare.outsideChipLabel": "Dieser Chat liegt in {workspace}. Sonst siehst du nichts davon.",
    "chatShare.outsideAgent":
      "Der eigene Agent von {workspace} arbeitet nur für dessen Mitglieder. Was du schreibst, beantwortet {agent}.",
    "chatShare.outsideNoAgent":
      "Kein Agent hier steht dir offen. Du kannst diesen Chat lesen, und {creator} kann ihn fortsetzen.",
    "chatShare.refusal.personal_conversation_private":
      "Dieser Chat hat etwas genutzt, das nur du nutzen kannst (deine Mails, deinen eigenen Skill oder Agenten). Er bleibt deiner. Starte einen neuen Chat, um gemeinsam daran zu arbeiten.",
    "chatShare.refusal.data_store_conversation_private":
      "Dieser Chat liest den Data Store „{store}“, den {name} nicht lesen darf. Er bleibt deiner.",
    "chatShare.refusal.subject_conversation_private":
      "Dieser Chat arbeitet an einem Entwurf, den nur liest, wer ihn ändern darf ({right}). {name} darf das nicht.",
    "chatShare.refusal.conversation_in_project":
      "Dieser Chat liegt in einem Projekt. Teile stattdessen das Projekt.",
    "chatShare.refusal.personal_workspace_conversation":
      "Persönliche Chats bleiben deine. Verschiebe diesen Chat in ein Team, um ihn zu teilen.",
    "chatShare.refusal.conversation_not_shareable":
      "Nur ein privater Chat in einem Team, außerhalb von Projekten, lässt sich mit einzelnen Personen teilen.",
    "chatShare.refusal.share_creator_only":
      "Nur wer diesen Chat begonnen hat, bestimmt, wer ihn sieht.",
    "chatShare.refusal.share_first_party_only":
      "Nur du selbst, angemeldet, änderst, wer einen Chat sieht.",
    "chatShare.refusal.share_person_unavailable": "{name} kann nicht hinzugefügt werden.",
    "chatShare.refusal.share_people_limit":
      "Ein Chat wird mit höchstens 20 Personen geteilt. Für mehr mach ihn zum Team-Chat oder zu einem Projekt.",
    "chatShare.refusal.share_checks_changed":
      "Der Chat hat sich inzwischen geändert. Versuch es noch einmal.",
    "chatShare.refusal.person_run_active":
      "{name} hat gerade einen Lauf in diesem Chat. Versuch es noch einmal, wenn er endet."
  }
});
