// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access > Roles: the role list, a role's page and the notice of undecided rights
// (ADR-0028, AP-5b1).
export const accessRoles = defineTranslations({
  en: {
    "access.tabRoles": "Roles",
    "access.kindRoles": "Built-in roles",
    "access.actionEditBuiltInRolesDescription":
      "Change the rights of User and Admin, reset them and decide what a release brings. A change reaches everybody who holds the role.",
    "access.rolesIntro":
      "A role is a set of rights across all workspaces. Every person holds User and may hold further roles.",
    "access.rolesLoadFailed": "The roles could not be loaded.",
    "access.newRole": "New role",
    "access.roleBuiltIn": "Built in",
    "access.roleAsDelivered": "As delivered",
    "access.roleChanged": "Changed",
    "access.roleReadOnly": "Read-only",
    "access.roleRightsOne": "1 right",
    "access.roleRightsOther": "{count} rights",
    "access.rolePendingOne": "1 new right to decide",
    "access.rolePendingOther": "{count} new rights to decide",
    "access.roleMenu": "Actions for {name}",
    "access.roleRename": "Rename",
    "access.roleDelete": "Delete",
    "access.roleUserDescription": "Every person holds it: what it allows, everybody may.",
    "access.roleAdminDescription": "Manages assets, people and their rights across all workspaces.",
    "access.roleSuperadminDescription":
      "Holds every right of this release. Nobody changes it, so an admin can always repair the system from inside.",

    "access.newRoleDescription":
      "A new role starts with the rights of the role you copy. You change them on its page.",
    "access.roleName": "Name",
    "access.roleDescription": "Description",
    "access.roleCopyFrom": "Copy the rights of",
    "access.roleCreate": "Create role",
    "access.roleSave": "Save",
    "access.roleNameMissing": "Give the role a name.",
    "access.roleNameTaken": "Another role already has this name.",
    "access.roleInUse": "People still hold this role. Take it from them on the Users page first.",
    "access.roleNeedsRight": "This change needs the right “{right}”, which you do not hold.",
    "access.roleSuperadminOnly": "Only a Superadmin gives or takes this right.",
    "access.roleWriteFailed": "The role could not be saved.",
    "access.roleWaitsForApproval": "The change waits for an approval and has changed nothing yet.",
    "access.renameRoleTitle": "Rename {name}",
    "access.deleteRoleTitle": "Delete {name}?",
    "access.deleteRoleDescription": "The role and its rights are removed. This cannot be undone.",

    "access.allRoles": "All roles",
    "access.roleResetToDefault": "Reset to default",
    "access.roleResetTitle": "Reset {name} to its default?",
    "access.roleResetDescription":
      "The role gets the rights this release delivers it with, and every undecided right is settled. It applies at once to everybody who holds the role.",
    "access.roleBuiltInEffect": "A change applies at once to everybody who holds this role.",
    "access.roleBuiltInNotEditable":
      "You can view this role. Changing it needs the right “{right}”.",

    "access.areaNone": "No right in this area.",
    "access.areaEdit": "Edit",
    "access.areaEditLabel": "Edit the rights for {area}",
    "access.areaRemoveLabel": "Remove a right for {area}",
    "access.areaDialogTitle": "{area} in {role}",
    "access.areaDialogDescription":
      "Each right you tick applies across all workspaces. Rights in one workspace or on one asset, and refusals, stay as they are.",
    "access.rightNotHeld": "You do not hold this right, so you cannot give it.",
    "access.rightRefusedByRole": "The role refuses this right. Remove the refusal first.",
    "access.roleSaveRights": "Save rights",
    "access.roleRevokeAllowDescription":
      "Everybody who holds {name} loses this right at once, unless another role or right gives it: {action}, {scope}.",
    "access.roleRevokeDenyDescription": "{name} no longer refuses this: {action}, {scope}.",

    "access.pendingAddedOne": "1 right is new in this release and not in this role",
    "access.pendingAddedOther": "{count} rights are new in this release and not in this role",
    "access.pendingRemovedOne": "1 right was taken out of this role's default and is still in it",
    "access.pendingRemovedOther":
      "{count} rights were taken out of this role's default and are still in it",
    "access.pendingAdd": "Add",
    "access.pendingLeaveOut": "Leave out",
    "access.pendingTakeAway": "Remove",
    "access.pendingKeep": "Keep",
    "access.pendingDecideFailed": "The decision could not be saved.",
    "access.pendingNotice": "A release brought rights that are not decided yet for: {roles}.",
    "access.pendingNoticeOpen": "Open roles"
  },
  de: {
    "access.tabRoles": "Rollen",
    "access.kindRoles": "Eingebaute Rollen",
    "access.actionEditBuiltInRolesDescription":
      "Die Rechte von Benutzer und Admin ändern, sie zurücksetzen und entscheiden, was ein Release bringt. Eine Änderung trifft alle, die die Rolle haben.",
    "access.rolesIntro":
      "Eine Rolle bündelt Rechte für alle Arbeitsbereiche. Jede Person hat die Rolle Benutzer und kann weitere Rollen haben.",
    "access.rolesLoadFailed": "Die Rollen konnten nicht geladen werden.",
    "access.newRole": "Neue Rolle",
    "access.roleBuiltIn": "Eingebaut",
    "access.roleAsDelivered": "Wie ausgeliefert",
    "access.roleChanged": "Geändert",
    "access.roleReadOnly": "Schreibgeschützt",
    "access.roleRightsOne": "1 Recht",
    "access.roleRightsOther": "{count} Rechte",
    "access.rolePendingOne": "1 neues Recht zu entscheiden",
    "access.rolePendingOther": "{count} neue Rechte zu entscheiden",
    "access.roleMenu": "Aktionen für {name}",
    "access.roleRename": "Umbenennen",
    "access.roleDelete": "Löschen",
    "access.roleUserDescription": "Jede Person hat sie: Was sie erlaubt, dürfen alle.",
    "access.roleAdminDescription":
      "Verwaltet Assets, Personen und deren Rechte in allen Arbeitsbereichen.",
    "access.roleSuperadminDescription":
      "Hat jedes Recht dieses Release. Niemand ändert sie, damit ein Admin das System immer von innen reparieren kann.",

    "access.newRoleDescription":
      "Eine neue Rolle beginnt mit den Rechten der Rolle, die du kopierst. Ändern kannst du sie auf ihrer Seite.",
    "access.roleName": "Name",
    "access.roleDescription": "Beschreibung",
    "access.roleCopyFrom": "Rechte übernehmen von",
    "access.roleCreate": "Rolle anlegen",
    "access.roleSave": "Speichern",
    "access.roleNameMissing": "Gib der Rolle einen Namen.",
    "access.roleNameTaken": "Eine andere Rolle hat schon diesen Namen.",
    "access.roleInUse":
      "Personen haben diese Rolle noch. Nimm sie ihnen zuerst auf der Seite Benutzer.",
    "access.roleNeedsRight": "Dafür brauchst du das Recht „{right}“, das du nicht hast.",
    "access.roleSuperadminOnly": "Nur Superadmins vergeben oder entziehen dieses Recht.",
    "access.roleWriteFailed": "Die Rolle konnte nicht gespeichert werden.",
    "access.roleWaitsForApproval":
      "Die Änderung wartet auf eine Freigabe und hat noch nichts geändert.",
    "access.renameRoleTitle": "{name} umbenennen",
    "access.deleteRoleTitle": "{name} löschen?",
    "access.deleteRoleDescription":
      "Die Rolle und ihre Rechte werden entfernt. Das lässt sich nicht rückgängig machen.",

    "access.allRoles": "Alle Rollen",
    "access.roleResetToDefault": "Auf Standard zurücksetzen",
    "access.roleResetTitle": "{name} auf den Standard zurücksetzen?",
    "access.roleResetDescription":
      "Die Rolle bekommt die Rechte, mit denen dieses Release sie ausliefert, und jedes offene Recht ist damit entschieden. Das gilt sofort für alle, die die Rolle haben.",
    "access.roleBuiltInEffect": "Eine Änderung gilt sofort für alle, die diese Rolle haben.",
    "access.roleBuiltInNotEditable":
      "Du kannst diese Rolle ansehen. Um sie zu ändern, brauchst du das Recht „{right}“.",

    "access.areaNone": "Kein Recht in diesem Bereich.",
    "access.areaEdit": "Bearbeiten",
    "access.areaEditLabel": "Rechte für {area} bearbeiten",
    "access.areaRemoveLabel": "Ein Recht für {area} entfernen",
    "access.areaDialogTitle": "{area} in {role}",
    "access.areaDialogDescription":
      "Jedes Recht, das du ankreuzt, gilt für alle Arbeitsbereiche. Rechte in einem Arbeitsbereich oder für ein Asset und Verweigerungen bleiben, wie sie sind.",
    "access.rightNotHeld": "Du hast dieses Recht nicht und kannst es daher nicht vergeben.",
    "access.rightRefusedByRole":
      "Die Rolle verweigert dieses Recht. Hebe zuerst die Verweigerung auf.",
    "access.roleSaveRights": "Rechte speichern",
    "access.roleRevokeAllowDescription":
      "Alle mit der Rolle {name} verlieren dieses Recht sofort, sofern keine andere Rolle und kein anderes Recht es ihnen gibt: {action}, {scope}.",
    "access.roleRevokeDenyDescription": "{name} verweigert das nicht mehr: {action}, {scope}.",

    "access.pendingAddedOne": "1 Recht ist neu in diesem Release und nicht in dieser Rolle",
    "access.pendingAddedOther":
      "{count} Rechte sind neu in diesem Release und nicht in dieser Rolle",
    "access.pendingRemovedOne":
      "1 Recht wurde aus dem Standard dieser Rolle genommen und ist noch in ihr",
    "access.pendingRemovedOther":
      "{count} Rechte wurden aus dem Standard dieser Rolle genommen und sind noch in ihr",
    "access.pendingAdd": "Hinzufügen",
    "access.pendingLeaveOut": "Weglassen",
    "access.pendingTakeAway": "Entfernen",
    "access.pendingKeep": "Behalten",
    "access.pendingDecideFailed": "Die Entscheidung konnte nicht gespeichert werden.",
    "access.pendingNotice":
      "Ein Release hat Rechte gebracht, die noch nicht entschieden sind für: {roles}.",
    "access.pendingNoticeOpen": "Rollen öffnen"
  }
});
