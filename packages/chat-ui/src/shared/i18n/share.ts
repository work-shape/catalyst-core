import { defineTranslations } from "./translation-area";

// "Teilen mit…" (SHARE-1): an asset moves up the ladder Nur ich → Team → Alle, at once with the
// right at the target, otherwise as a request a person with that right decides in the Inbox.
export const share = defineTranslations({
  en: {
    "share.action": "Share…",
    "share.withEveryone": "Share with everyone…",
    "share.withTeam": "Share with {team}…",
    "share.title": "Share “{title}”",
    "share.description":
      "Sharing moves it one step up: Only me, then a team, then Everyone. It does not move back.",
    "share.target": "With whom?",
    "share.targetTeamHint": "The members of {team}",
    "share.targetAllHint": "Everyone it is offered to",
    "share.checking": "Checking what sharing it changes…",
    "share.checkFailed": "What sharing it changes could not be read. Try again.",
    "share.moves": "What goes along",
    "share.movesUses": "“{title}” and what it uses from here:",
    "share.data": "Data",
    "share.usersAfter": "Who uses it then",
    "share.usersTeam": "The members of {team}",
    "share.usersAll": "Everyone it is offered to",
    "share.editorsAfter": "Who changes it then",
    "share.editorsTeam": "Whoever may build in {team}",
    "share.editorsAll": "Admins, and whoever may build for everyone",
    "share.youEdit": "You too.",
    "share.youNoLonger": "You no longer can.",
    "share.grantsDropped": "Rights that end",
    "share.grantsOnAssets":
      "{count} rights to single parts end, because changing it follows its place.",
    "share.grantsOnAssetsOne":
      "1 right to a single part ends, because changing it follows its place.",
    "share.grantsRunAccounts": "{count} rights of a Workflow's run account at the old place end.",
    "share.grantsRunAccountsOne": "1 right of a Workflow's run account at the old place ends.",
    "share.breaksTitle": "This stops working",
    "share.breaksLine": "“{title}” uses “{uses}”",
    "share.breaksConfirm": "I understand that this stops working afterwards",
    "share.request":
      "You may not share it there yourself. A request goes to the people who may; they decide in their Inbox, and until then it stays where it is.",
    "share.submitDirect": "Share",
    "share.submitRequest": "Send request",
    "share.requested":
      "Request sent. Someone who may share it there decides in their Inbox; until then it stays where it is.",
    "share.close": "Close",
    "inbox.kindAssetMove": "Request to share",
    "inbox.moveHeadingAll": "{actor} asks to share “{title}” with everyone",
    "inbox.moveHeadingTeam": "{actor} asks to share “{title}” with {team}",
    "inbox.moveEnded": "Nothing was shared.",
    "inbox.moveAccept": "Accept",
    "inbox.moveDecline": "Decline"
  },
  de: {
    "share.action": "Teilen…",
    "share.withEveryone": "Für alle teilen…",
    "share.withTeam": "Mit {team} teilen…",
    "share.title": "„{title}“ teilen",
    "share.description":
      "Teilen verschiebt es eine Stufe höher: Nur ich, dann ein Team, dann Alle. Zurück geht es nicht.",
    "share.target": "Mit wem?",
    "share.targetTeamHint": "Die Mitglieder von {team}",
    "share.targetAllHint": "Alle, denen es angeboten wird",
    "share.checking": "Wird geprüft, was das Teilen ändert…",
    "share.checkFailed": "Was das Teilen ändert, ließ sich nicht lesen. Versuch es noch einmal.",
    "share.moves": "Was mitgeht",
    "share.movesUses": "„{title}“ und was es von hier verwendet:",
    "share.data": "Daten",
    "share.usersAfter": "Wer es danach nutzt",
    "share.usersTeam": "Die Mitglieder von {team}",
    "share.usersAll": "Alle, denen es angeboten wird",
    "share.editorsAfter": "Wer es danach ändert",
    "share.editorsTeam": "Wer in {team} bauen darf",
    "share.editorsAll": "Admins und wer für alle bauen darf",
    "share.youEdit": "Du auch.",
    "share.youNoLonger": "Du dann nicht mehr.",
    "share.grantsDropped": "Rechte, die enden",
    "share.grantsOnAssets":
      "{count} Rechte auf einzelne Teile enden, weil das Ändern dem Ort folgt.",
    "share.grantsOnAssetsOne":
      "1 Recht auf ein einzelnes Teil endet, weil das Ändern dem Ort folgt.",
    "share.grantsRunAccounts":
      "{count} Rechte des Ausführungskontos eines Workflows am alten Ort enden.",
    "share.grantsRunAccountsOne":
      "1 Recht des Ausführungskontos eines Workflows am alten Ort endet.",
    "share.breaksTitle": "Das funktioniert danach nicht mehr",
    "share.breaksLine": "„{title}“ verwendet „{uses}“",
    "share.breaksConfirm": "Ich verstehe, dass das danach nicht mehr funktioniert",
    "share.request":
      "Dort darfst du nicht selbst teilen. Eine Anfrage geht an die, die es dürfen; sie entscheiden in ihrer Inbox, bis dahin bleibt es, wo es ist.",
    "share.submitDirect": "Teilen",
    "share.submitRequest": "Anfrage senden",
    "share.requested":
      "Anfrage gesendet. Wer dort teilen darf, entscheidet in der Inbox; bis dahin bleibt es, wo es ist.",
    "share.close": "Schließen",
    "inbox.kindAssetMove": "Anfrage zum Teilen",
    "inbox.moveHeadingAll": "{actor} möchte „{title}“ für alle teilen",
    "inbox.moveHeadingTeam": "{actor} möchte „{title}“ mit {team} teilen",
    "inbox.moveEnded": "Es wurde nichts geteilt.",
    "inbox.moveAccept": "Annehmen",
    "inbox.moveDecline": "Ablehnen"
  }
});
