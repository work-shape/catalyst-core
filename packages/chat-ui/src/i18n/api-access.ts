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
    apiAccessGrants: "Rights",
    apiAccessInheritsGrants: "Inherits the service principal's rights",
    apiAccessKeyPrefix: "Key prefix",
    apiAccessLastUsed: "Last used",
    apiAccessName: "Name",
    apiAccessNever: "Never",
    apiAccessNeverExpires: "Never expires",
    apiAccessNoCredentials: "No API keys have been created for this service principal.",
    apiAccessNoDescription: "No description",
    apiAccessNoGrants: "No rights",
    apiAccessPrincipalsForbidden:
      "You may not see the service principals. That takes the right to manage service principals.",
    apiAccessReadGrant: "View configuration",
    apiAccessReadGrantDescription:
      "Pull, inspect and compare agents, skills and other managed configuration.",
    apiAccessReleaseGrant: "Push configuration releases",
    apiAccessReleaseGrantDescription: "Push managed configuration to this instance.",
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
    apiAccessRightsGiveConnection: "Give this service principal a Connection to use",
    apiAccessRightsGiveFailed: "The right could not be given. Try again.",
    apiAccessRightsGiveFirst: "Give this service principal a right",
    apiAccessRightsGivenBy: "Given by {name} on {date}",
    apiAccessRightsGivenOn: "Given on {date}",
    apiAccessRightsHiddenResource: "A resource you cannot see",
    apiAccessRightsIncomplete: "Choose a resource.",
    apiAccessRightsInstance: "Instance",
    apiAccessRightsInvalidScope:
      "This resource no longer exists or is of another kind. Close this dialog, reload the page and choose the resource again.",
    apiAccessRightsKind: "Kind of resource",
    apiAccessRightsLoadFailed: "The rights could not be loaded.",
    apiAccessRightsMay: "May {verb}",
    apiAccessRightsMayUseConnection: "May use this Connection",
    apiAccessRightsNoResources:
      "Nothing to choose: the service principal already holds this right on every resource you can see.",
    apiAccessRightsNoneGrantable:
      "This instance has no kind of resource a service principal can be given a right on.",
    apiAccessRightsNotHeld: "You do not hold this right here yourself, so you cannot give it.",
    apiAccessRightsNotHeldAnywhere:
      "You do not hold this right on any of these resources yourself, so you cannot give it.",
    apiAccessRightsNotAdministrable:
      "You may not give rights to service principals. That takes someone who manages service principals and holds the right themselves. Ask them to add this right.",
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
    apiAccessServicePrincipalsDescription:
      "Accounts for the CLI and automation, managed apart from users.",
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
    apiAccessCreatePrincipal: "Technisches Konto erstellen",
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
    apiAccessEditPrincipal: "Technisches Konto bearbeiten",
    apiAccessEmpty: "Noch keine Technischen Konten",
    apiAccessEmptyDescription:
      "Erstelle ein Technisches Konto für eng begrenzten Zugriff der CLI oder einer Automatisierung.",
    apiAccessExpired: "Abgelaufen",
    apiAccessExpires: "Gültig bis",
    apiAccessExpiresAt: "Gültig bis (optional)",
    apiAccessGrants: "Rechte",
    apiAccessInheritsGrants: "Übernimmt die Rechte des Technischen Kontos",
    apiAccessKeyPrefix: "Schlüsselpräfix",
    apiAccessLastUsed: "Zuletzt verwendet",
    apiAccessName: "Name",
    apiAccessNever: "Nie",
    apiAccessNeverExpires: "Läuft nie ab",
    apiAccessNoCredentials: "Für dieses Technische Konto wurden noch keine API-Schlüssel erstellt.",
    apiAccessNoDescription: "Keine Beschreibung",
    apiAccessNoGrants: "Keine Rechte",
    apiAccessPrincipalsForbidden:
      "Du darfst die Technischen Konten nicht sehen. Dafür braucht es das Recht, Technische Konten zu verwalten.",
    apiAccessReadGrant: "Konfiguration ansehen",
    apiAccessReadGrantDescription:
      "Agenten, Skills und andere verwaltete Konfiguration abrufen, prüfen und vergleichen.",
    apiAccessReleaseGrant: "Konfiguration per Release einspielen",
    apiAccessReleaseGrantDescription: "Verwaltete Konfiguration auf diese Instanz übertragen.",
    apiAccessRevoke: "Widerrufen",
    apiAccessRevokeCredential: "API-Schlüssel widerrufen?",
    apiAccessRevokeDescription:
      "Dieser Schlüssel funktioniert sofort nicht mehr. Dies kann nicht rückgängig gemacht werden.",
    apiAccessRevoked: "Widerrufen",
    apiAccessRightsActionNotGrantable:
      "Die Instanz vergibt dieses Recht nicht an ein Technisches Konto: Es kann nur Ressourcen verwenden. Wähle eines der hier angebotenen Rechte. Passt keines, lade die Seite neu.",
    apiAccessRightsAdd: "Recht hinzufügen",
    apiAccessRightsChooseConnection: "Verbindung wählen",
    apiAccessRightsChooseResource: "Ressource wählen",
    apiAccessRightsDescription:
      "Was dieses Technische Konto verwenden darf, Ressource für Ressource. Ein Workflow, der als dieses Konto läuft, braucht ein Recht auf jeder Verbindung, die er aufruft.",
    apiAccessRightsDialogDescription:
      "Das Recht gilt für diese eine Ressource. Auf später angelegte Ressourcen erhält das Technische Konto nichts.",
    apiAccessRightsDialogTitle: "Neues Recht für {principal}",
    apiAccessRightsDisabledNote:
      "Dieses Technische Konto ist deaktiviert. Es behält seine Rechte und kann keines davon nutzen, bis es aktiviert wird.",
    apiAccessRightsDuplicate:
      "Das Technische Konto hat dieses Recht auf dieser Ressource bereits. Es wurde nichts geändert. Schließe diesen Dialog.",
    apiAccessRightsEffectNotGrantable:
      "Einem Technischen Konto kann kein Recht verweigert werden. Um ein Recht zu nehmen, entferne es aus der Liste.",
    apiAccessRightsEmpty:
      "Dieses Technische Konto darf noch keine Ressource verwenden. Ein Workflow, der als dieses Konto läuft, kann nur eine Verbindung aufrufen, die das Konto erhalten hat.",
    apiAccessRightsEmptyReadOnly: "Dieses Technische Konto darf keine Ressource verwenden.",
    apiAccessRightsForbidden: "Du darfst die Rechte von Technischen Konten nicht sehen.",
    apiAccessRightsGiveConnection: "Diesem Konto eine Verbindung zum Verwenden geben",
    apiAccessRightsGiveFailed: "Das Recht konnte nicht vergeben werden. Versuche es erneut.",
    apiAccessRightsGiveFirst: "Diesem Konto ein Recht geben",
    apiAccessRightsGivenBy: "Vergeben von {name} am {date}",
    apiAccessRightsGivenOn: "Vergeben am {date}",
    apiAccessRightsHiddenResource: "Eine Ressource, die du nicht sehen kannst",
    apiAccessRightsIncomplete: "Wähle eine Ressource.",
    apiAccessRightsInstance: "Instanz",
    apiAccessRightsInvalidScope:
      "Diese Ressource gibt es nicht mehr oder sie ist von anderer Art. Schließe diesen Dialog, lade die Seite neu und wähle die Ressource erneut.",
    apiAccessRightsKind: "Art der Ressource",
    apiAccessRightsLoadFailed: "Die Rechte konnten nicht geladen werden.",
    apiAccessRightsMay: "Darf {verb}",
    apiAccessRightsMayUseConnection: "Darf diese Verbindung verwenden",
    apiAccessRightsNoResources:
      "Nichts zu wählen: Das Technische Konto hat dieses Recht bereits auf jeder Ressource, die du siehst.",
    apiAccessRightsNoneGrantable:
      "Diese Instanz hat keine Art von Ressource, auf der ein Technisches Konto ein Recht erhalten kann.",
    apiAccessRightsNotHeld:
      "Du hast dieses Recht hier selbst nicht und kannst es deshalb nicht weitergeben.",
    apiAccessRightsNotHeldAnywhere:
      "Du hast dieses Recht auf keiner dieser Ressourcen selbst und kannst es deshalb nicht weitergeben.",
    apiAccessRightsNotAdministrable:
      "Du darfst Technischen Konten keine Rechte geben. Das kann nur, wer Technische Konten verwaltet und das Recht selbst hat. Bitte so jemanden darum, dieses Recht hinzuzufügen.",
    apiAccessRightsRemove: "Entfernen",
    apiAccessRightsRemoveDescription:
      "{principal} kann {resource} sofort nicht mehr verwenden. Ein Workflow, der als dieses Konto läuft und {resource} aufruft, schlägt von da an fehl.",
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
      "Dieses Technische Konto gibt es nicht mehr. Schließe diesen Dialog und lade die Seite neu.",
    apiAccessRightsUseConnectionHint:
      "Aufrufe der Operationen der Verbindung durch einen Workflow, der als dieses Technische Konto läuft. Die Verbindung ändern kann er nicht.",
    apiAccessRightsWorkspace: "Arbeitsbereich {name}",
    apiAccessRightsWorkspaceUnnamed: "Arbeitsbereich",
    apiAccessSave: "Speichern",
    apiAccessScopes: "Was der Schlüssel darf",
    apiAccessSecretOnce:
      "Kopiere diesen Schlüssel jetzt. Er wird nur einmal angezeigt und kann später nicht abgerufen werden.",
    apiAccessServerUrl: "Server-URL",
    apiAccessServicePrincipals: "Technische Konten",
    apiAccessServicePrincipalsDescription:
      "Konten für die CLI und Automatisierungen, getrennt von den Benutzern verwaltet.",
    apiAccessStatus: "Status",
    apiAccessWaitsForApproval:
      "Diese Änderung wartet auf eine Freigabe. Bisher wurde nichts geändert."
  }
});
