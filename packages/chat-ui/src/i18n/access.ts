import { defineTranslations } from "./translation-area";

export const access = defineTranslations({
  en: {
    "access.description":
      "Give a person rights on agents and skills inside a Namespace or on one asset, and check what a person may do.",
    "access.tabs": "Parts of Access",
    "access.tabNamespaces": "Namespaces",
    "access.tabGrants": "Grants",
    "access.tabCheck": "Check",
    "access.notAvailable": "Not available",
    "access.actions": "Actions",

    "access.namespacesLoadFailed": "The Namespaces could not be loaded.",
    "access.namespacesEmpty":
      "No Namespace yet. A Namespace is a name prefix such as kai- that a person gets rights in.",
    "access.newNamespace": "New Namespace",
    "access.editNamespace": "Edit",
    "access.deleteNamespace": "Delete",
    "access.namespacePrefix": "Prefix",
    "access.namespaceDisplayName": "Display name",
    "access.namespaceAssets": "Assets",
    "access.namespaceGrants": "Grants",
    "access.namespaceTools": "Tools",
    "access.namespaceModels": "Models",
    "access.namespaceNoLimit": "No limit",
    "access.namespaceListed": "{count} listed",
    "access.namespaceNoneAllowed": "None allowed",
    "access.namespaceMenu": "Actions for {prefix}",
    "access.namespaceInUseOne": "{count} grant names this Namespace. Revoke it first.",
    "access.namespaceInUseOther": "{count} grants name this Namespace. Revoke them first.",
    "access.namespaceDeleteTitle": "Delete Namespace {prefix}?",
    "access.namespaceDeleteDescription":
      "The prefix becomes free again. Agents and skills with this prefix stay as they are and are no longer limited by its tool and model lists.",
    "access.namespaceDeleteFailed": "The Namespace could not be deleted.",
    "access.namespaceCreateTitle": "New Namespace",
    "access.namespaceEditTitle": "Edit Namespace {prefix}",
    "access.namespaceDialogDescription":
      "Agents and skills whose names start with the prefix belong to the Namespace.",
    "access.namespacePrefixHint":
      "Lowercase words joined by hyphens, ending in a hyphen, such as kai-. It cannot be changed later.",
    "access.namespacePrefixFixed": "A prefix cannot be changed.",
    "access.namespacePrefixLength": "A prefix has between {min} and {max} characters.",
    "access.namespacePrefixPattern":
      "Use lowercase letters and digits, joined by single hyphens, and end with a hyphen.",
    "access.namespacePrefixOverlap":
      "This prefix overlaps the registered Namespace {prefix}. A name can belong to one Namespace only.",
    "access.namespaceDisplayNameRequired": "Enter a display name.",
    "access.limitTools": "Limit tools",
    "access.limitToolsHint": "Off: agents in this Namespace may use every tool of the instance.",
    "access.limitModels": "Limit models",
    "access.limitModelsHint":
      "Off: only a person with the right to manage models can set the model of an agent here.",
    "access.chooseTools": "Choose tools",
    "access.chooseModels": "Choose models",
    "access.chosenCount": "{count} of {total} chosen",
    "access.toolsEmptyHint":
      "No tool is chosen. An agent in this Namespace cannot be saved with any tool.",
    "access.modelsEmptyHint":
      "No model is chosen. Nobody without the right to manage models can create or save an agent in this Namespace.",
    "access.modelsListedHint":
      "A person with write rights here may pick one of these models without the right to manage models.",
    "access.referencesLoadFailed":
      "The tools, models and assets of the instance could not be loaded.",
    "access.namespaceLockTitle": "This locks out everyone who writes through a grant",
    "access.namespaceLockToolsOne":
      "{count} agent already has this prefix. With an empty tool list it can no longer be saved with a tool by anyone who writes through a grant, the release sync included.",
    "access.namespaceLockToolsOther":
      "{count} agents already have this prefix. With an empty tool list they can no longer be saved with a tool by anyone who writes through a grant, the release sync included.",
    "access.namespaceLockModelsOne":
      "{count} agent already has this prefix. With an empty model list it can no longer be saved by anyone who writes through a grant, the release sync included.",
    "access.namespaceLockModelsOther":
      "{count} agents already have this prefix. With an empty model list they can no longer be saved by anyone who writes through a grant, the release sync included.",
    "access.namespaceSaveFailed": "The Namespace could not be saved.",
    "access.namespaceListEntryGone":
      "A chosen tool or model no longer exists on this instance. Open the list and choose again.",
    "access.createNamespace": "Create Namespace",
    "access.saveNamespace": "Save",

    "access.grantsLoadFailed": "The grants could not be loaded.",
    "access.grantsEmpty":
      "No grant yet. A grant allows or denies one person an action in a Namespace or on one asset.",
    "access.newGrant": "Grant",
    "access.grantHolder": "Person",
    "access.grantAction": "Action",
    "access.grantScope": "Scope",
    "access.grantEffect": "Effect",
    "access.grantedBy": "Granted by",
    "access.effectAllow": "Allow",
    "access.effectDeny": "Deny",
    "access.scopeNamespace": "Namespace {prefix}",
    "access.scopeAgent": "Agent {name}",
    "access.scopeSkill": "Skill {name}",
    "access.scopeAssetGone": "Asset no longer exists",
    "access.scopeAssetGoneHint":
      "This deny stays until you revoke it. It applies again when an asset with this name is created.",
    "access.scopeAssetUnknown": "One asset",
    "access.unknownUser": "Unknown user",
    "access.actionRead": "Read",
    "access.actionWrite": "Write",
    "access.actionDelete": "Delete",
    "access.kindAgent": "Agents",
    "access.kindSkill": "Skills",
    "access.actionOnAgent": "{action} agents",
    "access.actionOnSkill": "{action} skills",
    "access.grantMenu": "Actions for the grant of {name}",
    "access.revoke": "Revoke",
    "access.revokeTitle": "Revoke this grant?",
    "access.revokeAllowDescription": "{name} loses this right at once: {action}, {scope}.",
    "access.revokeDenyDescription":
      "{name} is no longer denied this: {action}, {scope}. Other grants and the person's role then decide.",
    "access.revokeFailed": "The grant could not be revoked.",
    "access.grantDialogTitle": "Grant",
    "access.grantDialogDescription":
      "One row is written for each action you tick. Instance-wide rights are set on the Users page.",
    "access.choosePerson": "Choose a person",
    "access.usersLoadFailed": "The users could not be loaded.",
    "access.grantKind": "Kind",
    "access.grantActions": "Actions",
    "access.grantScopeKind": "Where",
    "access.scopeInNamespace": "In a Namespace",
    "access.scopeInNamespaceDescription":
      "Every asset of the kind whose name starts with the prefix.",
    "access.scopeOnAsset": "On one asset",
    "access.scopeOnAssetDescription": "One existing agent or skill.",
    "access.chooseNamespace": "Choose a Namespace",
    "access.chooseAsset": "Choose an asset",
    "access.grantNamespace": "Namespace",
    "access.grantAsset": "Asset",
    "access.noNamespaces": "Register a Namespace first.",
    "access.effectAllowDescription": "The person may do the ticked actions there.",
    "access.effectDenyDescription":
      "Wins over every grant and role for the ticked actions there. It is not a wall: a person with instance-wide rights can still export a denied agent or set it as the default. Whoever is denied reading or writing an asset cannot delete it. A deny on one asset stays when the asset is deleted, until you revoke it.",
    "access.submitGrant": "Grant",
    "access.grantIncomplete": "Choose a person, at least one action and where it applies.",
    "access.grantFailed": "The grant could not be written.",
    "access.grantDuplicate": "The person already has this row: {action}.",
    "access.grantUserBeingDeleted": "User account is being deleted",
    "access.grantUnknownHolder": "This user no longer exists.",
    "access.grantUnknownNamespace": "This Namespace is no longer registered.",
    "access.grantAssetGone": "This asset no longer exists or is of another kind.",
    "access.grantPartlyWritten": "{written} of {total} rows were written before this.",

    "access.checkDescription":
      "Choose a person and name an agent or a skill. The name does not have to exist yet.",
    "access.checkPerson": "Person",
    "access.checkKind": "Kind",
    "access.checkName": "Asset name",
    "access.checkNamePlaceholder": "kai-helper",
    "access.checkPickAsset": "Pick an existing asset",
    "access.checkEmpty":
      "Choose a person and enter an asset name to see what the person may do with it.",
    "access.checkLoadFailed": "The rights of this person could not be loaded.",
    "access.checkHolderHidden": "This user was not found.",
    "access.checkHolderInactive":
      "This account is not active. It holds nothing until it is active again, whatever its grants say.",
    "access.checkResult": "Rights of {name} on {asset}",
    "access.checkDecision": "Decision",
    "access.checkDecidedBy": "Decided by",
    "access.checkAllowed": "Allowed",
    "access.checkRefused": "Refused",
    "access.reasonRole": "Role",
    "access.reasonLegacy": "Individual right",
    "access.reasonGrant": "Grant",
    "access.reasonDeny": "Deny",
    "access.reasonNoGrant": "No grant",
    "access.reasonHolderInactive": "Account not active",
    "access.decidedByRole": "The person's instance role allows this everywhere.",
    "access.decidedByLegacy": "An individual right set on the Users page allows this everywhere.",
    "access.decidedByLegacyDeny": "An individual right was revoked on the Users page.",
    "access.decidedByGrantNamespace": "Grant in Namespace {prefix}",
    "access.decidedByGrantAsset": "Grant on this asset",
    "access.decidedByDenyNamespace": "Deny in Namespace {prefix}",
    "access.decidedByDenyAsset": "Deny on this asset",
    "access.decidedByDenyThrough":
      "{deny} ({action}). Whoever is denied reading or writing an asset cannot delete it.",
    "access.decidedByNothing": "No role, right or grant covers this.",
    "access.checkInstanceRightsNote":
      "A deny on an asset does not take away instance-wide rights: with them a person can still export the asset or set an agent as the default."
  },
  de: {
    "access.description":
      "Gib einer Person Rechte an Agenten und Fähigkeiten in einem Namespace oder an einem einzelnen Asset und prüfe, was eine Person darf.",
    "access.tabs": "Bereiche von Zugriff",
    "access.tabNamespaces": "Namespaces",
    "access.tabGrants": "Rechte",
    "access.tabCheck": "Prüfen",
    "access.notAvailable": "Nicht verfügbar",
    "access.actions": "Aktionen",

    "access.namespacesLoadFailed": "Die Namespaces konnten nicht geladen werden.",
    "access.namespacesEmpty":
      "Noch kein Namespace. Ein Namespace ist ein Namenspräfix wie kai-, in dem eine Person Rechte bekommt.",
    "access.newNamespace": "Neuer Namespace",
    "access.editNamespace": "Bearbeiten",
    "access.deleteNamespace": "Löschen",
    "access.namespacePrefix": "Präfix",
    "access.namespaceDisplayName": "Anzeigename",
    "access.namespaceAssets": "Assets",
    "access.namespaceGrants": "Rechte",
    "access.namespaceTools": "Werkzeuge",
    "access.namespaceModels": "Modelle",
    "access.namespaceNoLimit": "Keine Grenze",
    "access.namespaceListed": "{count} gelistet",
    "access.namespaceNoneAllowed": "Keines erlaubt",
    "access.namespaceMenu": "Aktionen für {prefix}",
    "access.namespaceInUseOne": "{count} Recht nennt diesen Namespace. Entziehe es zuerst.",
    "access.namespaceInUseOther": "{count} Rechte nennen diesen Namespace. Entziehe sie zuerst.",
    "access.namespaceDeleteTitle": "Namespace {prefix} löschen?",
    "access.namespaceDeleteDescription":
      "Das Präfix wird wieder frei. Agenten und Fähigkeiten mit diesem Präfix bleiben unverändert und sind nicht mehr durch seine Werkzeug- und Modelllisten begrenzt.",
    "access.namespaceDeleteFailed": "Der Namespace konnte nicht gelöscht werden.",
    "access.namespaceCreateTitle": "Neuer Namespace",
    "access.namespaceEditTitle": "Namespace {prefix} bearbeiten",
    "access.namespaceDialogDescription":
      "Agenten und Fähigkeiten, deren Name mit dem Präfix beginnt, gehören zum Namespace.",
    "access.namespacePrefixHint":
      "Kleingeschriebene Wörter, mit Bindestrichen verbunden, am Ende ein Bindestrich, zum Beispiel kai-. Es lässt sich später nicht ändern.",
    "access.namespacePrefixFixed": "Ein Präfix lässt sich nicht ändern.",
    "access.namespacePrefixLength": "Ein Präfix hat zwischen {min} und {max} Zeichen.",
    "access.namespacePrefixPattern":
      "Verwende Kleinbuchstaben und Ziffern, mit einzelnen Bindestrichen verbunden, und ende mit einem Bindestrich.",
    "access.namespacePrefixOverlap":
      "Dieses Präfix überschneidet sich mit dem registrierten Namespace {prefix}. Ein Name kann nur zu einem Namespace gehören.",
    "access.namespaceDisplayNameRequired": "Gib einen Anzeigenamen ein.",
    "access.limitTools": "Werkzeuge begrenzen",
    "access.limitToolsHint":
      "Aus: Agenten in diesem Namespace dürfen jedes Werkzeug der Instanz verwenden.",
    "access.limitModels": "Modelle begrenzen",
    "access.limitModelsHint":
      "Aus: Nur eine Person mit dem Recht, Modelle zu verwalten, kann hier das Modell eines Agenten festlegen.",
    "access.chooseTools": "Werkzeuge wählen",
    "access.chooseModels": "Modelle wählen",
    "access.chosenCount": "{count} von {total} gewählt",
    "access.toolsEmptyHint":
      "Kein Werkzeug gewählt. Ein Agent in diesem Namespace kann mit keinem Werkzeug gespeichert werden.",
    "access.modelsEmptyHint":
      "Kein Modell gewählt. Niemand ohne das Recht, Modelle zu verwalten, kann in diesem Namespace einen Agenten anlegen oder speichern.",
    "access.modelsListedHint":
      "Eine Person mit Schreibrecht hier darf eines dieser Modelle wählen, ohne das Recht, Modelle zu verwalten.",
    "access.referencesLoadFailed":
      "Die Werkzeuge, Modelle und Assets der Instanz konnten nicht geladen werden.",
    "access.namespaceLockTitle": "Das sperrt alle aus, die über ein vergebenes Recht schreiben",
    "access.namespaceLockToolsOne":
      "{count} Agent hat dieses Präfix bereits. Mit einer leeren Werkzeugliste kann ihn niemand mehr mit einem Werkzeug speichern, der über ein vergebenes Recht schreibt, auch der Release-Abgleich nicht.",
    "access.namespaceLockToolsOther":
      "{count} Agenten haben dieses Präfix bereits. Mit einer leeren Werkzeugliste kann sie niemand mehr mit einem Werkzeug speichern, der über ein vergebenes Recht schreibt, auch der Release-Abgleich nicht.",
    "access.namespaceLockModelsOne":
      "{count} Agent hat dieses Präfix bereits. Mit einer leeren Modellliste kann ihn niemand mehr speichern, der über ein vergebenes Recht schreibt, auch der Release-Abgleich nicht.",
    "access.namespaceLockModelsOther":
      "{count} Agenten haben dieses Präfix bereits. Mit einer leeren Modellliste kann sie niemand mehr speichern, der über ein vergebenes Recht schreibt, auch der Release-Abgleich nicht.",
    "access.namespaceSaveFailed": "Der Namespace konnte nicht gespeichert werden.",
    "access.namespaceListEntryGone":
      "Ein gewähltes Werkzeug oder Modell gibt es auf dieser Instanz nicht mehr. Öffne die Liste und wähle neu.",
    "access.createNamespace": "Namespace anlegen",
    "access.saveNamespace": "Speichern",

    "access.grantsLoadFailed": "Die Rechte konnten nicht geladen werden.",
    "access.grantsEmpty":
      "Noch kein Recht vergeben. Ein Recht erlaubt oder verweigert einer Person eine Aktion in einem Namespace oder an einem Asset.",
    "access.newGrant": "Recht vergeben",
    "access.grantHolder": "Person",
    "access.grantAction": "Aktion",
    "access.grantScope": "Geltungsbereich",
    "access.grantEffect": "Wirkung",
    "access.grantedBy": "Vergeben von",
    "access.effectAllow": "Erlauben",
    "access.effectDeny": "Verweigern",
    "access.scopeNamespace": "Namespace {prefix}",
    "access.scopeAgent": "Agent {name}",
    "access.scopeSkill": "Fähigkeit {name}",
    "access.scopeAssetGone": "Asset existiert nicht mehr",
    "access.scopeAssetGoneHint":
      "Diese Verweigerung bleibt, bis du sie entziehst. Sie gilt wieder, sobald ein Asset mit diesem Namen angelegt wird.",
    "access.scopeAssetUnknown": "Ein Asset",
    "access.unknownUser": "Unbekannter Benutzer",
    "access.actionRead": "Lesen",
    "access.actionWrite": "Schreiben",
    "access.actionDelete": "Löschen",
    "access.kindAgent": "Agenten",
    "access.kindSkill": "Fähigkeiten",
    "access.actionOnAgent": "Agenten: {action}",
    "access.actionOnSkill": "Fähigkeiten: {action}",
    "access.grantMenu": "Aktionen für das Recht von {name}",
    "access.revoke": "Entziehen",
    "access.revokeTitle": "Dieses Recht entziehen?",
    "access.revokeAllowDescription": "{name} verliert dieses Recht sofort: {action}, {scope}.",
    "access.revokeDenyDescription":
      "{name} wird dies nicht mehr verweigert: {action}, {scope}. Danach entscheiden andere Rechte und die Rolle der Person.",
    "access.revokeFailed": "Das Recht konnte nicht entzogen werden.",
    "access.grantDialogTitle": "Recht vergeben",
    "access.grantDialogDescription":
      "Für jede angehakte Aktion wird eine Zeile geschrieben. Instanzweite Rechte setzt du auf der Seite Benutzer.",
    "access.choosePerson": "Person wählen",
    "access.usersLoadFailed": "Die Benutzer konnten nicht geladen werden.",
    "access.grantKind": "Art",
    "access.grantActions": "Aktionen",
    "access.grantScopeKind": "Wo",
    "access.scopeInNamespace": "In einem Namespace",
    "access.scopeInNamespaceDescription":
      "Jedes Asset der Art, dessen Name mit dem Präfix beginnt.",
    "access.scopeOnAsset": "An einem Asset",
    "access.scopeOnAssetDescription": "Ein vorhandener Agent oder eine vorhandene Fähigkeit.",
    "access.chooseNamespace": "Namespace wählen",
    "access.chooseAsset": "Asset wählen",
    "access.grantNamespace": "Namespace",
    "access.grantAsset": "Asset",
    "access.noNamespaces": "Registriere zuerst einen Namespace.",
    "access.effectAllowDescription": "Die Person darf die angehakten Aktionen dort ausführen.",
    "access.effectDenyDescription":
      "Geht dort für die angehakten Aktionen jedem Recht und jeder Rolle vor. Es ist keine Mauer: Eine Person mit instanzweiten Rechten kann einen verweigerten Agenten weiterhin exportieren oder als Standard festlegen. Wem das Lesen oder Schreiben eines Assets verweigert ist, der kann es nicht löschen. Eine Verweigerung an einem Asset bleibt, wenn das Asset gelöscht wird, bis du sie entziehst.",
    "access.submitGrant": "Vergeben",
    "access.grantIncomplete": "Wähle eine Person, mindestens eine Aktion und wo sie gilt.",
    "access.grantFailed": "Das Recht konnte nicht geschrieben werden.",
    "access.grantDuplicate": "Die Person hat diese Zeile bereits: {action}.",
    "access.grantUserBeingDeleted": "Das Benutzerkonto wird gerade gelöscht",
    "access.grantUnknownHolder": "Diesen Benutzer gibt es nicht mehr.",
    "access.grantUnknownNamespace": "Dieser Namespace ist nicht mehr registriert.",
    "access.grantAssetGone": "Dieses Asset gibt es nicht mehr oder es ist von anderer Art.",
    "access.grantPartlyWritten": "Davor wurden {written} von {total} Zeilen geschrieben.",

    "access.checkDescription":
      "Wähle eine Person und nenne einen Agenten oder eine Fähigkeit. Den Namen muss es noch nicht geben.",
    "access.checkPerson": "Person",
    "access.checkKind": "Art",
    "access.checkName": "Asset-Name",
    "access.checkNamePlaceholder": "kai-helper",
    "access.checkPickAsset": "Vorhandenes Asset wählen",
    "access.checkEmpty":
      "Wähle eine Person und gib einen Asset-Namen ein, um zu sehen, was die Person damit darf.",
    "access.checkLoadFailed": "Die Rechte dieser Person konnten nicht geladen werden.",
    "access.checkHolderHidden": "Dieser Benutzer wurde nicht gefunden.",
    "access.checkHolderInactive":
      "Dieses Konto ist nicht aktiv. Es hält nichts, bis es wieder aktiv ist, egal was seine Rechte sagen.",
    "access.checkResult": "Rechte von {name} an {asset}",
    "access.checkDecision": "Entscheidung",
    "access.checkDecidedBy": "Entschieden durch",
    "access.checkAllowed": "Erlaubt",
    "access.checkRefused": "Abgelehnt",
    "access.reasonRole": "Rolle",
    "access.reasonLegacy": "Einzelnes Recht",
    "access.reasonGrant": "Vergebenes Recht",
    "access.reasonDeny": "Verweigerung",
    "access.reasonNoGrant": "Kein Recht",
    "access.reasonHolderInactive": "Konto nicht aktiv",
    "access.decidedByRole": "Die Instanzrolle der Person erlaubt das überall.",
    "access.decidedByLegacy": "Ein einzelnes Recht von der Seite Benutzer erlaubt das überall.",
    "access.decidedByLegacyDeny": "Ein einzelnes Recht wurde auf der Seite Benutzer entzogen.",
    "access.decidedByGrantNamespace": "Recht im Namespace {prefix}",
    "access.decidedByGrantAsset": "Recht an diesem Asset",
    "access.decidedByDenyNamespace": "Verweigerung im Namespace {prefix}",
    "access.decidedByDenyAsset": "Verweigerung an diesem Asset",
    "access.decidedByDenyThrough":
      "{deny} ({action}). Wem das Lesen oder Schreiben eines Assets verweigert ist, der kann es nicht löschen.",
    "access.decidedByNothing":
      "Keine Rolle, kein einzelnes Recht und kein vergebenes Recht deckt das ab.",
    "access.checkInstanceRightsNote":
      "Eine Verweigerung an einem Asset nimmt keine instanzweiten Rechte: Damit kann eine Person das Asset weiterhin exportieren oder einen Agenten als Standard festlegen."
  }
});
