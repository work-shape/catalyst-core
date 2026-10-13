import { defineTranslations } from "./translation-area";

export const apiAccess = defineTranslations({
  en: {
    apiAccessActive: "Active",
    apiAccessApiKey: "API key",
    apiAccessApiKeys: "API keys",
    apiAccessApiKeysDescription: "Credentials used by the CLI and other automated clients.",
    apiAccessCopyFailed: "The value could not be copied. Select it and copy it by hand.",
    apiAccessCreateCredential: "Create API key",
    apiAccessCreatePrincipal: "Create service principal",
    apiAccessCreatedAt: "Created",
    apiAccessCredential: "credential",
    apiAccessCredentialNamePlaceholder: "For example: CI production",
    apiAccessCredentialReady: "API key created",
    apiAccessCredentials: "credentials",
    apiAccessDescription: "Manage non-human access for the Catalyst CLI and automation.",
    apiAccessDescriptionLabel: "Description",
    apiAccessDisabled: "Disabled",
    apiAccessDone: "Done",
    apiAccessEdit: "Edit",
    apiAccessEditPrincipal: "Edit service principal",
    apiAccessEmpty: "No service principals yet",
    apiAccessEmptyDescription: "Create one to give the CLI or automation narrowly scoped access.",
    apiAccessExpired: "Expired",
    apiAccessExpires: "Expires",
    apiAccessExpiresAt: "Expires at (optional)",
    apiAccessGrants: "Grants",
    apiAccessInheritsGrants: "Inherits principal grants",
    apiAccessKeyPrefix: "Key prefix",
    apiAccessLastUsed: "Last used",
    apiAccessName: "Name",
    apiAccessNever: "Never",
    apiAccessNeverExpires: "Never expires",
    apiAccessNoCredentials: "No API keys have been created for this service principal.",
    apiAccessNoDescription: "No description",
    apiAccessNoGrants: "No grants",
    apiAccessReadGrant: "Read configuration assets",
    apiAccessReadGrantDescription: "Pull, inspect, and compare managed configuration assets.",
    apiAccessReleaseGrant: "Release configuration assets",
    apiAccessReleaseGrantDescription: "Push managed configuration assets to this instance.",
    apiAccessRevoke: "Revoke",
    apiAccessRevokeCredential: "Revoke API key?",
    apiAccessRevokeDescription:
      "This key will stop working immediately. This action cannot be undone.",
    apiAccessRevoked: "Revoked",
    apiAccessRightsActionNotGrantable:
      "The instance does not give this right to a service principal: it can only be allowed to use a resource. Choose one of the rights offered here. If none fits, reload the page.",
    apiAccessRightsAdd: "Add right",
    apiAccessRightsChooseConnection: "Choose a Connection",
    apiAccessRightsChooseResource: "Choose a resource",
    apiAccessRightsDescription:
      "What this service principal may use, one resource at a time. A Workflow that runs as it needs a right on every Connection it calls.",
    apiAccessRightsDialogDescription:
      "The right covers this one resource. The service principal gets nothing on a resource created later.",
    apiAccessRightsDialogTitle: "New right for {principal}",
    apiAccessRightsDisabledNote:
      "This service principal is disabled. It keeps its rights and can use none of them until it is enabled.",
    apiAccessRightsDuplicate:
      "The service principal already holds this right on this resource. Nothing was changed. Close this dialog.",
    apiAccessRightsEffectNotGrantable:
      "A service principal cannot be denied a right. To take a right away, remove it from the list.",
    apiAccessRightsEmpty:
      "This service principal may not use any resource yet. A Workflow that runs as it can only call a Connection the principal was given.",
    apiAccessRightsEmptyReadOnly: "This service principal may not use any resource.",
    apiAccessRightsForbidden: "You may not see the rights of service principals.",
    apiAccessRightsGiveConnection: "Give this principal a Connection to use",
    apiAccessRightsGiveFailed: "The right could not be given. Try again.",
    apiAccessRightsGiveFirst: "Give this principal a right",
    apiAccessRightsGivenBy: "Given by {name} on {date}",
    apiAccessRightsGivenOn: "Given on {date}",
    apiAccessRightsHiddenResource: "A resource you cannot see",
    apiAccessRightsIncomplete: "Choose a resource.",
    apiAccessRightsInstance: "Instance",
    apiAccessRightsInvalidScope:
      "This resource no longer exists or is of another kind. Close this dialog, reload the page and choose the resource again.",
    apiAccessRightsKind: "Kind of resource",
    apiAccessRightsLoadFailed: "The rights could not be loaded.",
    apiAccessRightsMay: "May: {action}",
    apiAccessRightsMayUseConnection: "May use this Connection",
    apiAccessRightsNoResources:
      "Nothing to choose: the service principal already holds this right on every resource you can see.",
    apiAccessRightsNoneGrantable:
      "This instance has no kind of resource a service principal can be given a right on.",
    apiAccessRightsNotAdministrable:
      "You may not give rights to service principals. That takes a superadmin who manages API access. Ask one to add this right.",
    apiAccessRightsRemove: "Remove",
    apiAccessRightsRemoveDescription:
      "{principal} can no longer use {resource}, at once. A Workflow that runs as it and calls {resource} fails from then on.",
    apiAccessRightsRemoveFailed: "The right could not be removed. Try again.",
    apiAccessRightsRemoveNamed: "Remove the right on {resource}",
    apiAccessRightsRemoveTitle: "Remove this right?",
    apiAccessRightsResource: "Resource",
    apiAccessRightsResourceGone: "Deleted",
    apiAccessRightsResourceGoneHint: "The resource was deleted. Remove this right.",
    apiAccessRightsResourcesFailed: "The resources could not be loaded. Reload the page.",
    apiAccessRightsRight: "Right",
    apiAccessRightsSubmit: "Give right",
    apiAccessRightsTitle: "Rights on resources",
    apiAccessRightsUnknownHolder:
      "This service principal no longer exists. Close this dialog and reload the page.",
    apiAccessRightsUseConnectionHint:
      "Calls of the Connection's operations by a Workflow that runs as this service principal. It cannot change the Connection.",
    apiAccessRightsWorkspace: "Workspace {name}",
    apiAccessRightsWorkspaceUnnamed: "Workspace",
    apiAccessSave: "Save",
    apiAccessScopes: "Key scopes",
    apiAccessSecretOnce: "Copy this key now. It is shown once and cannot be retrieved later.",
    apiAccessServerUrl: "Server URL",
    apiAccessServicePrincipals: "Service principals",
    apiAccessServicePrincipalsDescription: "Machine identities are managed separately from users.",
    apiAccessStatus: "Status",
    apiAccessWaitsForApproval: "This change waits for an approval. Nothing has changed yet."
  },
  de: {
    apiAccessActive: "Aktiv",
    apiAccessApiKey: "API-Schlüssel",
    apiAccessApiKeys: "API-Schlüssel",
    apiAccessApiKeysDescription: "Zugangsdaten für die CLI und andere automatisierte Clients.",
    apiAccessCopyFailed:
      "Der Wert konnte nicht kopiert werden. Markiere ihn und kopiere ihn von Hand.",
    apiAccessCreateCredential: "API-Schlüssel erstellen",
    apiAccessCreatePrincipal: "Service Principal erstellen",
    apiAccessCreatedAt: "Erstellt",
    apiAccessCredential: "Zugangsdaten",
    apiAccessCredentialNamePlaceholder: "Zum Beispiel: CI Produktion",
    apiAccessCredentialReady: "API-Schlüssel erstellt",
    apiAccessCredentials: "Zugangsdaten",
    apiAccessDescription:
      "Nicht-menschliche Zugriffe für die Catalyst CLI und Automatisierung verwalten.",
    apiAccessDescriptionLabel: "Beschreibung",
    apiAccessDisabled: "Deaktiviert",
    apiAccessDone: "Fertig",
    apiAccessEdit: "Bearbeiten",
    apiAccessEditPrincipal: "Service Principal bearbeiten",
    apiAccessEmpty: "Noch keine Service Principals",
    apiAccessEmptyDescription:
      "Erstelle einen Service Principal für eng begrenzten CLI- oder Automatisierungszugriff.",
    apiAccessExpired: "Abgelaufen",
    apiAccessExpires: "Gültig bis",
    apiAccessExpiresAt: "Gültig bis (optional)",
    apiAccessGrants: "Berechtigungen",
    apiAccessInheritsGrants: "Übernimmt Principal-Berechtigungen",
    apiAccessKeyPrefix: "Schlüsselpräfix",
    apiAccessLastUsed: "Zuletzt verwendet",
    apiAccessName: "Name",
    apiAccessNever: "Nie",
    apiAccessNeverExpires: "Läuft nie ab",
    apiAccessNoCredentials:
      "Für diesen Service Principal wurden noch keine API-Schlüssel erstellt.",
    apiAccessNoDescription: "Keine Beschreibung",
    apiAccessNoGrants: "Keine Berechtigungen",
    apiAccessReadGrant: "Konfigurations-Assets lesen",
    apiAccessReadGrantDescription:
      "Verwaltete Konfigurations-Assets abrufen, prüfen und vergleichen.",
    apiAccessReleaseGrant: "Konfigurations-Assets veröffentlichen",
    apiAccessReleaseGrantDescription:
      "Verwaltete Konfigurations-Assets auf diese Instanz übertragen.",
    apiAccessRevoke: "Widerrufen",
    apiAccessRevokeCredential: "API-Schlüssel widerrufen?",
    apiAccessRevokeDescription:
      "Dieser Schlüssel funktioniert sofort nicht mehr. Dies kann nicht rückgängig gemacht werden.",
    apiAccessRevoked: "Widerrufen",
    apiAccessRightsActionNotGrantable:
      "Die Instanz vergibt dieses Recht nicht an einen Service Principal: Er kann nur die Verwendung einer Ressource erhalten. Wähle eines der hier angebotenen Rechte. Passt keines, lade die Seite neu.",
    apiAccessRightsAdd: "Recht hinzufügen",
    apiAccessRightsChooseConnection: "Verbindung wählen",
    apiAccessRightsChooseResource: "Ressource wählen",
    apiAccessRightsDescription:
      "Was dieser Service Principal verwenden darf, Ressource für Ressource. Ein Workflow, der als dieser Service Principal läuft, braucht ein Recht auf jeder Verbindung, die er aufruft.",
    apiAccessRightsDialogDescription:
      "Das Recht gilt für diese eine Ressource. Auf später angelegte Ressourcen erhält der Service Principal nichts.",
    apiAccessRightsDialogTitle: "Neues Recht für {principal}",
    apiAccessRightsDisabledNote:
      "Dieser Service Principal ist deaktiviert. Er behält seine Rechte und kann keines davon nutzen, bis er aktiviert wird.",
    apiAccessRightsDuplicate:
      "Der Service Principal hat dieses Recht auf dieser Ressource bereits. Es wurde nichts geändert. Schließe diesen Dialog.",
    apiAccessRightsEffectNotGrantable:
      "Einem Service Principal kann kein Recht verweigert werden. Um ein Recht zu nehmen, entferne es aus der Liste.",
    apiAccessRightsEmpty:
      "Dieser Service Principal darf noch keine Ressource verwenden. Ein Workflow, der als dieser Service Principal läuft, kann nur eine Verbindung aufrufen, die der Principal erhalten hat.",
    apiAccessRightsEmptyReadOnly: "Dieser Service Principal darf keine Ressource verwenden.",
    apiAccessRightsForbidden: "Du darfst die Rechte von Service Principals nicht sehen.",
    apiAccessRightsGiveConnection: "Diesem Principal eine Verbindung zur Verwendung geben",
    apiAccessRightsGiveFailed: "Das Recht konnte nicht vergeben werden. Versuche es erneut.",
    apiAccessRightsGiveFirst: "Diesem Principal ein Recht geben",
    apiAccessRightsGivenBy: "Vergeben von {name} am {date}",
    apiAccessRightsGivenOn: "Vergeben am {date}",
    apiAccessRightsHiddenResource: "Eine Ressource, die du nicht sehen kannst",
    apiAccessRightsIncomplete: "Wähle eine Ressource.",
    apiAccessRightsInstance: "Instanz",
    apiAccessRightsInvalidScope:
      "Diese Ressource gibt es nicht mehr oder sie ist von anderer Art. Schließe diesen Dialog, lade die Seite neu und wähle die Ressource erneut.",
    apiAccessRightsKind: "Art der Ressource",
    apiAccessRightsLoadFailed: "Die Rechte konnten nicht geladen werden.",
    apiAccessRightsMay: "Darf: {action}",
    apiAccessRightsMayUseConnection: "Darf diese Verbindung verwenden",
    apiAccessRightsNoResources:
      "Nichts zu wählen: Der Service Principal hat dieses Recht bereits auf jeder Ressource, die du siehst.",
    apiAccessRightsNoneGrantable:
      "Diese Instanz hat keine Art von Ressource, auf der ein Service Principal ein Recht erhalten kann.",
    apiAccessRightsNotAdministrable:
      "Du darfst Service Principals keine Rechte geben. Das kann nur ein Superadmin, der den API-Zugriff verwaltet. Bitte einen darum, dieses Recht hinzuzufügen.",
    apiAccessRightsRemove: "Entfernen",
    apiAccessRightsRemoveDescription:
      "{principal} kann {resource} sofort nicht mehr verwenden. Ein Workflow, der als dieser Service Principal läuft und {resource} aufruft, schlägt von da an fehl.",
    apiAccessRightsRemoveFailed: "Das Recht konnte nicht entfernt werden. Versuche es erneut.",
    apiAccessRightsRemoveNamed: "Recht auf {resource} entfernen",
    apiAccessRightsRemoveTitle: "Dieses Recht entfernen?",
    apiAccessRightsResource: "Ressource",
    apiAccessRightsResourceGone: "Gelöscht",
    apiAccessRightsResourceGoneHint: "Die Ressource wurde gelöscht. Entferne dieses Recht.",
    apiAccessRightsResourcesFailed:
      "Die Ressourcen konnten nicht geladen werden. Lade die Seite neu.",
    apiAccessRightsRight: "Recht",
    apiAccessRightsSubmit: "Recht vergeben",
    apiAccessRightsTitle: "Rechte auf Ressourcen",
    apiAccessRightsUnknownHolder:
      "Diesen Service Principal gibt es nicht mehr. Schließe diesen Dialog und lade die Seite neu.",
    apiAccessRightsUseConnectionHint:
      "Aufrufe der Operationen der Verbindung durch einen Workflow, der als dieser Service Principal läuft. Die Verbindung ändern kann er nicht.",
    apiAccessRightsWorkspace: "Arbeitsbereich {name}",
    apiAccessRightsWorkspaceUnnamed: "Arbeitsbereich",
    apiAccessSave: "Speichern",
    apiAccessScopes: "Schlüsselberechtigungen",
    apiAccessSecretOnce:
      "Kopiere diesen Schlüssel jetzt. Er wird nur einmal angezeigt und kann später nicht abgerufen werden.",
    apiAccessServerUrl: "Server-URL",
    apiAccessServicePrincipals: "Service Principals",
    apiAccessServicePrincipalsDescription:
      "Maschinenidentitäten werden getrennt von Benutzern verwaltet.",
    apiAccessStatus: "Status",
    apiAccessWaitsForApproval:
      "Diese Änderung wartet auf eine Freigabe. Bisher wurde nichts geändert."
  }
});
