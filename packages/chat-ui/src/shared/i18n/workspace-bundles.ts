import { defineTranslations } from "./translation-area";

// AP-3: Builder and Publisher per member on Workspace > Members, and the request for one an
// instance admin decides in the Inbox. The bundles' own names and what they allow are the
// words of `rights.ts` and `access-workspace.ts`.
export const workspaceBundles = defineTranslations({
  en: {
    "workspaceBundles.switch": "{bundle} for {name}",
    "workspaceBundles.requested": "requested",
    "workspaceBundles.inherited": "by role or group",
    "workspaceBundles.refused": "You may not change this right.",
    "workspaceBundles.changed": "This changed in the meantime. The list now shows how it stands.",
    "inbox.kindGrantRequest": "Right in a workspace",
    "inbox.grantRequestHeading": "{actor} asks for {bundle} for {member} in {workspace}",
    "inbox.grantRequestHeadingSelf": "{member} asks for {bundle} in {workspace}",
    "inbox.grantRequestWorkspace": "Workspace",
    "inbox.grantRequestMember": "Member",
    "inbox.grantRequestRight": "Right",
    "inbox.grantRequestAllows": "What it allows",
    "inbox.grantRequestReason": "Reason",
    "inbox.grantRequestWaits":
      "Nothing changes until you grant it. The workspace's Owner or Admin can take it back at any time.",
    "inbox.grantRequestMemberLeft":
      "{member} is no longer a member of {workspace}. Granting gives nothing; decline the request.",
    "inbox.grantRequestMemberInactive":
      "The account of {member} is no longer active. Granting gives nothing; decline the request.",
    "inbox.grantRequestAlreadyHeld": "{member} already holds {bundle} in {workspace}.",
    "inbox.grantRequestGrant": "Grant",
    "inbox.grantRequestDecline": "Decline"
  },
  de: {
    "workspaceBundles.switch": "{bundle} für {name}",
    "workspaceBundles.requested": "angefragt",
    "workspaceBundles.inherited": "über Rolle oder Gruppe",
    "workspaceBundles.refused": "Du darfst dieses Recht nicht ändern.",
    "workspaceBundles.changed":
      "Das hat sich inzwischen geändert. Die Liste zeigt jetzt, wie es steht.",
    "inbox.kindGrantRequest": "Recht in einem Arbeitsbereich",
    "inbox.grantRequestHeading": "{actor} bittet um {bundle} für {member} in {workspace}",
    "inbox.grantRequestHeadingSelf": "{member} bittet um {bundle} in {workspace}",
    "inbox.grantRequestWorkspace": "Arbeitsbereich",
    "inbox.grantRequestMember": "Mitglied",
    "inbox.grantRequestRight": "Recht",
    "inbox.grantRequestAllows": "Was es erlaubt",
    "inbox.grantRequestReason": "Begründung",
    "inbox.grantRequestWaits":
      "Bis du es erteilst, ändert sich nichts. Owner oder Admin des Arbeitsbereichs können es jederzeit wieder entziehen.",
    "inbox.grantRequestMemberLeft":
      "{member} ist nicht mehr Mitglied von {workspace}. Erteilen gibt nichts; lehne die Anfrage ab.",
    "inbox.grantRequestMemberInactive":
      "Das Konto von {member} ist nicht mehr aktiv. Erteilen gibt nichts; lehne die Anfrage ab.",
    "inbox.grantRequestAlreadyHeld": "{member} hat {bundle} in {workspace} schon.",
    "inbox.grantRequestGrant": "Erteilen",
    "inbox.grantRequestDecline": "Ablehnen"
  }
});
