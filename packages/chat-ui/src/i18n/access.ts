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
    "access.namespacesEmpty": "No Namespace yet.",
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
      "No tool is chosen. Nobody can create or change an agent that names a tool in this Namespace, an instance administrator and the release sync included.",
    "access.modelsEmptyHint":
      "No model is chosen. Nobody can create or change an agent that names a model in this Namespace. An agent without a model can be saved only by a person with the right to manage models.",
    "access.modelsListedHint":
      "Every agent created or changed in this Namespace names one of these models, whoever saves it. A person with write rights here may pick one of them without the right to manage models. Only a person with that right may save an agent without a model.",
    "access.referencesLoadFailed":
      "The tools, models and assets of the instance could not be loaded.",
    "access.namespaceLockTitle": "An empty list binds everyone who saves an agent here",
    "access.namespaceSaveFailed": "The Namespace could not be saved.",
    "access.namespaceListEntryGone":
      "A chosen tool or model no longer exists on this instance. Open the list and choose again.",
    "access.createNamespace": "Create Namespace",
    "access.saveNamespace": "Save",

    "access.grantsLoadFailed": "The grants could not be loaded.",
    "access.grantsEmpty":
      "No grant yet. A grant allows or denies one person an action in a Namespace or on one asset.",
    "access.newGrant": "New grant",
    "access.grantHolder": "Person",
    "access.grantAction": "Action",
    "access.grantScope": "Scope",
    "access.grantEffect": "Effect",
    "access.grantedByLine": "Granted by {name}, {date}",
    "access.effectAllow": "Allow",
    "access.effectDeny": "Deny",
    "access.scopeNamespace": "Namespace {prefix}",
    "access.scopeAgent": "Agent {name}",
    "access.scopeSkill": "Skill {name}",
    "access.scopeAssetGone": "Asset no longer exists",
    "access.scopeAssetGoneHint":
      "This deny stays until you remove it. It applies again when an asset with this name is created.",
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
    "access.grantDialogTitle": "New grant",
    "access.grantDialogDescription":
      "One row is written for each action you tick. Rows the person already has are left as they are. Instance-wide rights are set on the Users page.",
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
      "Wins over grants and roles on this asset; holders of instance rights can still export it or set it as default. The documentation page Rights and Namespaces has the rest.",
    "access.submitGrant": "Create grant",
    "access.grantIncomplete": "Choose a person, at least one action and where it applies.",
    "access.grantFailed": "The grant could not be written.",
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
      "This account is not active. While it is not active it has no rights, whatever its grants say.",
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

    "access.namespacesIntro":
      "A Namespace is a name prefix such as kai-. Agents and skills whose names start with it belong to it, and a person can get rights inside it.",
    "access.referencesForbidden":
      "Your account lacks the right config_assets.read, so the tools, models and assets of the instance are not shown here.",
    "access.lockUnknown":
      "The agents with this prefix could not be counted. If there are any, this applies to them.",
    "access.lockAgentsOne": "{count} agent already has this prefix.",
    "access.lockAgentsOther": "{count} agents already have this prefix.",
    "access.lockAssetsOne": "{count} agent or skill already has this prefix.",
    "access.lockAssetsOther": "{count} agents and skills already have this prefix.",
    "access.lockTools":
      "Empty tool list: nobody can create or change an agent that names a tool here any more, an instance administrator and the release sync included.",
    "access.lockModels":
      "Empty model list: nobody can create or change an agent that names a model here any more. Only a person with the instance right to manage models can still save an agent here, and only without a model.",
    "access.namespaceLockConfirmTitle": "Save {prefix} with an empty list?",
    "access.namespaceLockConfirm": "Save anyway",
    "access.deniedAction": "Denied: {action}",
    "access.scopeAssetById": "Asset {id}",
    "access.revokeAllowItem": "Revoke: {action}",
    "access.revokeDenyItem": "Remove deny: {action}",
    "access.revokeDenyTitle": "Remove this deny?",
    "access.revokeDeny": "Remove deny",
    "access.grantNothingAdded": "Nothing was added. The person already has every row you chose.",
    "access.grantPartlyAdded": "{added} added. {existing} already there and left as they are.",
    "access.checkNameInvalidAgent": "An agent name is one word without spaces.",
    "access.checkNameInvalidSkill":
      "A skill name starts with a letter and uses only letters, digits, dots, hyphens and underscores.",
    "access.checkGrantsFailed":
      "The grants could not be loaded, so denies on single assets cannot be taken into account. No result is shown.",
    "access.checkAssetsFailed":
      "The agents and skills could not be loaded, so rows on single assets cannot be matched to this name. No result is shown.",
    "access.checkAssetsForbidden":
      "Your account lacks the right config_assets.read, so rows on single assets cannot be matched to this name. No result is shown.",
    "access.checkRightOnlyAgent":
      "This is the right alone. A save can still be refused: by a tool or model list of the Namespace, for a changed model setting without the right to manage models, when the first or last agent changes the default agent, or when agent configuration in the interface is switched off.",
    "access.checkRightOnlySkill":
      "This is the right alone. A save is still refused when agent configuration in the interface is switched off.",
    "access.checkNamespace": "This name lies in Namespace {prefix}, whose lists bind every writer.",
    "access.checkToolsNone": "Tools: none allowed.",
    "access.checkToolsListed": "Tools: only {list}.",
    "access.checkModelsNone":
      "Models: none allowed. Only a person with the right to manage models can save the agent, and only without a model.",
    "access.checkModelsListed": "Models: the agent names one of {list}.",
    "access.checkReadThroughGrant":
      "Read is allowed through a grant: the person can open this asset. The overview of all agents and skills and the export need the instance-wide right to read.",
    "access.checkDenyNote":
      "A deny on an asset does not take away instance-wide rights: with them a person can still export the asset or set an agent as the default."
  },
  de: {
    "access.description":
      "Gib einer Person Rechte an Agenten und Fähigkeiten in einem Namespace oder an einem einzelnen Asset und prüfe, was eine Person darf.",
    "access.tabs": "Abschnitte der Zugriffsseite",
    "access.tabNamespaces": "Namespaces",
    "access.tabGrants": "Rechte",
    "access.tabCheck": "Prüfen",
    "access.notAvailable": "Nicht verfügbar",
    "access.actions": "Aktionen",

    "access.namespacesLoadFailed": "Die Namespaces konnten nicht geladen werden.",
    "access.namespacesEmpty": "Noch kein Namespace.",
    "access.newNamespace": "Neuer Namespace",
    "access.editNamespace": "Bearbeiten",
    "access.deleteNamespace": "Löschen",
    "access.namespacePrefix": "Präfix",
    "access.namespaceDisplayName": "Anzeigename",
    "access.namespaceAssets": "Assets",
    "access.namespaceGrants": "Rechte",
    "access.namespaceTools": "Werkzeuge",
    "access.namespaceModels": "Modelle",
    "access.namespaceNoLimit": "Unbegrenzt",
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
      "Aus: Das Modell eines Agenten kann hier nur festlegen, wer das Recht hat, Modelle zu verwalten.",
    "access.chooseTools": "Werkzeuge wählen",
    "access.chooseModels": "Modelle wählen",
    "access.chosenCount": "{count} von {total} gewählt",
    "access.toolsEmptyHint":
      "Kein Werkzeug gewählt. Niemand kann in diesem Namespace einen Agenten anlegen oder ändern, der ein Werkzeug nennt, auch ein Instanzadministrator und der Release-Abgleich nicht.",
    "access.modelsEmptyHint":
      "Kein Modell gewählt. Niemand kann in diesem Namespace einen Agenten anlegen oder ändern, der ein Modell nennt. Einen Agenten ohne Modell kann nur speichern, wer das Recht hat, Modelle zu verwalten.",
    "access.modelsListedHint":
      "Jeder Agent, der in diesem Namespace angelegt oder geändert wird, nennt eines dieser Modelle, egal wer speichert. Eine Person mit Schreibrecht hier darf eines davon wählen, ohne das Recht, Modelle zu verwalten. Einen Agenten ohne Modell darf nur speichern, wer dieses Recht hat.",
    "access.referencesLoadFailed":
      "Die Werkzeuge, Modelle und Assets der Instanz konnten nicht geladen werden.",
    "access.namespaceLockTitle": "Eine leere Liste gilt für alle, die hier einen Agenten speichern",
    "access.namespaceSaveFailed": "Der Namespace konnte nicht gespeichert werden.",
    "access.namespaceListEntryGone":
      "Ein gewähltes Werkzeug oder Modell gibt es auf dieser Instanz nicht mehr. Öffne die Liste und wähle neu.",
    "access.createNamespace": "Namespace anlegen",
    "access.saveNamespace": "Speichern",

    "access.grantsLoadFailed": "Die Rechte konnten nicht geladen werden.",
    "access.grantsEmpty":
      "Noch kein Recht vergeben. Ein Recht erlaubt oder verweigert einer Person eine Aktion in einem Namespace oder an einem Asset.",
    "access.newGrant": "Neues Recht",
    "access.grantHolder": "Person",
    "access.grantAction": "Aktion",
    "access.grantScope": "Geltungsbereich",
    "access.grantEffect": "Wirkung",
    "access.grantedByLine": "Vergeben von {name}, {date}",
    "access.effectAllow": "Erlauben",
    "access.effectDeny": "Verweigern",
    "access.scopeNamespace": "Namespace {prefix}",
    "access.scopeAgent": "Agent {name}",
    "access.scopeSkill": "Fähigkeit {name}",
    "access.scopeAssetGone": "Asset existiert nicht mehr",
    "access.scopeAssetGoneHint":
      "Diese Verweigerung bleibt, bis du sie aufhebst. Sie gilt wieder, sobald ein Asset mit diesem Namen angelegt wird.",
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
      "{name} wird das nicht mehr verweigert: {action}, {scope}. Danach entscheiden die anderen Rechte und die Rolle der Person.",
    "access.revokeFailed": "Das Recht konnte nicht entzogen werden.",
    "access.grantDialogTitle": "Neues Recht",
    "access.grantDialogDescription":
      "Für jede angehakte Aktion wird eine Zeile geschrieben. Zeilen, die die Person schon hat, bleiben unverändert. Instanzweite Rechte setzt du auf der Seite Benutzer.",
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
      "Geht Rechten und Rollen an diesem Asset vor; wer instanzweite Rechte hat, kann es weiterhin exportieren oder als Standard festlegen. Alles Weitere steht in der Dokumentation auf der Seite Rights and Namespaces.",
    "access.submitGrant": "Recht anlegen",
    "access.grantIncomplete": "Wähle eine Person, mindestens eine Aktion und wo sie gilt.",
    "access.grantFailed": "Das Recht konnte nicht geschrieben werden.",
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
      "Dieses Konto ist nicht aktiv. Solange es nicht aktiv ist, hat es keine Rechte, unabhängig davon, was ihm vergeben wurde.",
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

    "access.namespacesIntro":
      "Ein Namespace ist ein Namenspräfix wie kai-. Agenten und Fähigkeiten, deren Name damit beginnt, gehören dazu, und eine Person kann darin Rechte bekommen.",
    "access.referencesForbidden":
      "Deinem Konto fehlt das Recht config_assets.read. Deshalb werden die Werkzeuge, Modelle und Assets der Instanz hier nicht angezeigt.",
    "access.lockUnknown":
      "Die Agenten mit diesem Präfix konnten nicht gezählt werden. Falls es welche gibt, gilt das für sie.",
    "access.lockAgentsOne": "{count} Agent hat dieses Präfix bereits.",
    "access.lockAgentsOther": "{count} Agenten haben dieses Präfix bereits.",
    "access.lockAssetsOne": "{count} Agent oder Fähigkeit hat dieses Präfix bereits.",
    "access.lockAssetsOther": "{count} Agenten und Fähigkeiten haben dieses Präfix bereits.",
    "access.lockTools":
      "Leere Werkzeugliste: Niemand kann hier mehr einen Agenten anlegen oder ändern, der ein Werkzeug nennt, auch ein Instanzadministrator und der Release-Abgleich nicht.",
    "access.lockModels":
      "Leere Modellliste: Niemand kann hier mehr einen Agenten anlegen oder ändern, der ein Modell nennt. Einen Agenten kann hier nur noch speichern, wer das instanzweite Recht hat, Modelle zu verwalten, und nur ohne Modell.",
    "access.namespaceLockConfirmTitle": "{prefix} mit leerer Liste speichern?",
    "access.namespaceLockConfirm": "Trotzdem speichern",
    "access.deniedAction": "Verweigert: {action}",
    "access.scopeAssetById": "Asset {id}",
    "access.revokeAllowItem": "Entziehen: {action}",
    "access.revokeDenyItem": "Verweigerung aufheben: {action}",
    "access.revokeDenyTitle": "Diese Verweigerung aufheben?",
    "access.revokeDeny": "Verweigerung aufheben",
    "access.grantNothingAdded":
      "Es wurde nichts hinzugefügt. Die Person hat alle gewählten Zeilen bereits.",
    "access.grantPartlyAdded":
      "{added} hinzugefügt. {existing} gab es schon, sie bleiben unverändert.",
    "access.checkNameInvalidAgent": "Ein Agentenname ist ein Wort ohne Leerzeichen.",
    "access.checkNameInvalidSkill":
      "Der Name einer Fähigkeit beginnt mit einem Buchstaben und besteht nur aus Buchstaben, Ziffern, Punkten, Bindestrichen und Unterstrichen.",
    "access.checkGrantsFailed":
      "Die Rechte konnten nicht geladen werden. Verweigerungen an einzelnen Assets lassen sich deshalb nicht berücksichtigen. Es wird kein Ergebnis angezeigt.",
    "access.checkAssetsFailed":
      "Die Agenten und Fähigkeiten konnten nicht geladen werden. Zeilen an einzelnen Assets lassen sich diesem Namen deshalb nicht zuordnen. Es wird kein Ergebnis angezeigt.",
    "access.checkAssetsForbidden":
      "Deinem Konto fehlt das Recht config_assets.read. Zeilen an einzelnen Assets lassen sich diesem Namen deshalb nicht zuordnen. Es wird kein Ergebnis angezeigt.",
    "access.checkRightOnlyAgent":
      "Das ist nur das Recht. Ein Speichern kann trotzdem abgelehnt werden: durch eine Werkzeug- oder Modellliste des Namespace, bei einer geänderten Modelleinstellung ohne das Recht, Modelle zu verwalten, wenn der erste oder letzte Agent den Standardagenten ändert, oder wenn die Agentenkonfiguration in der Oberfläche abgeschaltet ist.",
    "access.checkRightOnlySkill":
      "Das ist nur das Recht. Ein Speichern wird trotzdem abgelehnt, wenn die Agentenkonfiguration in der Oberfläche abgeschaltet ist.",
    "access.checkNamespace":
      "Dieser Name liegt im Namespace {prefix}. Dessen Listen gelten für alle, die schreiben.",
    "access.checkToolsNone": "Werkzeuge: keines erlaubt.",
    "access.checkToolsListed": "Werkzeuge: nur {list}.",
    "access.checkModelsNone":
      "Modelle: keines erlaubt. Den Agenten kann nur speichern, wer das Recht hat, Modelle zu verwalten, und nur ohne Modell.",
    "access.checkModelsListed": "Modelle: Der Agent nennt eines von {list}.",
    "access.checkReadThroughGrant":
      "Lesen ist über ein vergebenes Recht erlaubt: Die Person kann dieses Asset öffnen. Die Übersicht aller Agenten und Fähigkeiten und der Export brauchen das instanzweite Leserecht.",
    "access.checkDenyNote":
      "Eine Verweigerung an einem Asset nimmt keine instanzweiten Rechte: Damit kann eine Person das Asset weiterhin exportieren oder einen Agenten als Standard festlegen."
  }
});
