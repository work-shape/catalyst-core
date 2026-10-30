import { defineTranslations } from "./translation-area";

/** Settings > Instance > Policies (OP-2): the central policy of every action. */
export const policies = defineTranslations({
  en: {
    "settings.policies": "Policies",
    "policies.description":
      "Whether each action runs, asks the person it acts for first, needs someone's approval, or is off. A setting here holds wherever the action is called: in chat, in apps, in workflows and from the CLI.",
    "policies.loadFailed": "The policies could not be loaded.",
    "policies.saveFailed": "The change was not saved. Try again.",
    "policies.saved": "Saved",
    "policies.defaults": "Defaults",
    "policies.defaultsDescription":
      "What an action does where nothing below says otherwise. Set in the release config by whoever runs the instance.",
    "policies.defaultReading": "Actions that only read",
    "policies.defaultChanging": "Actions that change something",
    "policies.alwaysAllowClasses": "Who may choose Always allow",
    "policies.alwaysAllowClassesValue":
      "People may let their agents always do changes that can be undone. Changes that cannot be undone and changes that send something to others always ask.",
    "policies.value.allow": "Runs",
    "policies.value.confirm": "Asks first",
    "policies.value.approval": "Needs an approval",
    "policies.value.deny": "Off",
    "policies.valueSentence.allow": "Runs without asking",
    "policies.valueSentence.confirm": "Asks the person it acts for first",
    "policies.valueSentence.approval": "Waits for an approval by someone who may approve it",
    "policies.valueSentence.deny": "Off: it never runs and agents are not offered it",
    "policies.default": "Default: {value}",
    "policies.source.instance_default": "default of the instance",
    "policies.source.declared_default": "default of this action",
    "policies.source.central_setting": "set here",
    "policies.source.policy_floor": "this action always asks at least this",
    "policies.setByPattern": "set for {pattern}",
    "policies.setByDeployment": "set by the deployment",
    "policies.effect.reading": "Reads",
    "policies.effect.changing": "Changes",
    "policies.class.reversible": "can be undone",
    "policies.class.irreversible": "cannot be undone",
    "policies.class.outward": "sends to others",
    "policies.settings": "Settings",
    "policies.settingsDescription":
      "Each setting replaces the default of the actions it names. Where several match one call, the strictest wins.",
    "policies.settingsEmpty": "No settings. Every action follows its default.",
    "policies.everyWorkspace": "Every workspace",
    "policies.everyKind": "Every kind",
    "policies.inWorkspace": "In {workspace}",
    "policies.forKind": "For {kind}",
    "policies.unknownWorkspace": "a workspace that is gone",
    "policies.remove": "Remove",
    "policies.removeSetting": "Remove the setting for {operation}",
    "policies.valueOf": "Policy of {operation}",
    "policies.add": "Add a setting",
    "policies.addAction": "Add",
    "policies.operationField": "Action or pattern",
    "policies.operationHint":
      "An action's name, or every action under a prefix such as connection.crm.*",
    "policies.workspaceField": "Workspace",
    "policies.kindField": "Kind",
    "policies.valueField": "Policy",
    "policies.actions": "Actions",
    "policies.actionsDescription":
      "Every action of this instance. Open one to set its policy and whether people may always allow it.",
    "policies.search": "Search actions",
    "policies.kindFilter": "Show",
    "policies.allKinds": "All actions",
    "policies.kind.tool": "Agent tools",
    "policies.kind.connection": "Connections",
    "policies.kind.app": "Apps",
    "policies.kind.workflow": "Workflows",
    "policies.kind.data_store": "Data stores",
    "policies.kind.knowledge_base": "Knowledge bases",
    "policies.kind.platform": "Management",
    "policies.noMatch": "No action matches.",
    "policies.truncated":
      "Some actions under {prefix} are not listed: the list reads {limit} of them.",
    "policies.alwaysAllow": "People may always allow",
    "policies.alwaysAllowHint":
      "Off, everyone is asked each time, even where they chose Always allow before.",
    "policies.alwaysAllowNotForClass":
      "People cannot always allow this action: it cannot be undone or sends to others.",
    "policies.lockedByRelease":
      "The release config locks Always allow for this action. This screen cannot lift that lock; whoever runs the instance can.",
    "policies.lockedByPattern": "Locked by the setting for {pattern}.",
    "policies.locks": "Always allow locks",
    "policies.locksDescription":
      "Actions and patterns nobody may always allow. Locks of the release config are listed and cannot be lifted here.",
    "policies.locksEmpty": "No locks.",
    "policies.lockSource.release": "Release config",
    "policies.lockSource.instance": "Set here",
    "policies.unlock": "Lift",
    "policies.unlockLabel": "Lift the lock for {operation}",
    "policies.lockPattern": "Lock",
    "policies.refused.policy_names_itself":
      "The Policies screen's own actions keep their default, so the policy can always be changed again.",
    "policies.refused.unknown_operation":
      "This names no action of this instance. Name an action exactly, or every action under a prefix such as connection.crm.*",
    "policies.refused.reading_operation_waits":
      "This action only reads: it runs or is off, and asks nobody.",
    "policies.refused.locked_by_release":
      "The release config locks Always allow for this action. Whoever runs the instance can lift it."
  },
  de: {
    "settings.policies": "Richtlinien",
    "policies.description":
      "Ob jede Aktion läuft, zuerst die Person fragt, für die sie handelt, eine Freigabe braucht oder aus ist. Eine Einstellung hier gilt überall, wo die Aktion aufgerufen wird: im Chat, in Apps, in Workflows und über die CLI.",
    "policies.loadFailed": "Die Richtlinien konnten nicht geladen werden.",
    "policies.saveFailed": "Die Änderung wurde nicht gespeichert. Versuch es noch einmal.",
    "policies.saved": "Gespeichert",
    "policies.defaults": "Standard",
    "policies.defaultsDescription":
      "Was eine Aktion tut, wo unten nichts anderes steht. Festgelegt in der Release-Konfiguration von denen, die die Instanz betreiben.",
    "policies.defaultReading": "Aktionen, die nur lesen",
    "policies.defaultChanging": "Aktionen, die etwas ändern",
    "policies.alwaysAllowClasses": "Wer „Immer erlauben“ wählen darf",
    "policies.alwaysAllowClassesValue":
      "Personen dürfen ihren Agenten Änderungen, die sich rückgängig machen lassen, immer erlauben. Änderungen, die sich nicht rückgängig machen lassen oder etwas an andere senden, fragen immer.",
    "policies.value.allow": "Läuft",
    "policies.value.confirm": "Fragt zuerst",
    "policies.value.approval": "Braucht eine Freigabe",
    "policies.value.deny": "Aus",
    "policies.valueSentence.allow": "Läuft ohne zu fragen",
    "policies.valueSentence.confirm": "Fragt zuerst die Person, für die sie handelt",
    "policies.valueSentence.approval": "Wartet auf die Freigabe durch jemanden, der freigeben darf",
    "policies.valueSentence.deny": "Aus: Sie läuft nie, und Agenten wird sie nicht angeboten",
    "policies.default": "Standard: {value}",
    "policies.source.instance_default": "Standard der Instanz",
    "policies.source.declared_default": "Standard dieser Aktion",
    "policies.source.central_setting": "hier festgelegt",
    "policies.source.policy_floor": "diese Aktion fragt immer mindestens so",
    "policies.setByPattern": "festgelegt für {pattern}",
    "policies.setByDeployment": "festgelegt vom Deployment",
    "policies.effect.reading": "Liest",
    "policies.effect.changing": "Ändert",
    "policies.class.reversible": "rückgängig zu machen",
    "policies.class.irreversible": "nicht rückgängig zu machen",
    "policies.class.outward": "sendet an andere",
    "policies.settings": "Einstellungen",
    "policies.settingsDescription":
      "Jede Einstellung ersetzt den Standard der Aktionen, die sie nennt. Passen mehrere auf einen Aufruf, gilt die strengste.",
    "policies.settingsEmpty": "Keine Einstellungen. Jede Aktion folgt ihrem Standard.",
    "policies.everyWorkspace": "Jeder Arbeitsbereich",
    "policies.everyKind": "Jede Art",
    "policies.inWorkspace": "In {workspace}",
    "policies.forKind": "Für {kind}",
    "policies.unknownWorkspace": "einem Arbeitsbereich, den es nicht mehr gibt",
    "policies.remove": "Entfernen",
    "policies.removeSetting": "Einstellung für {operation} entfernen",
    "policies.valueOf": "Richtlinie für {operation}",
    "policies.add": "Einstellung hinzufügen",
    "policies.addAction": "Hinzufügen",
    "policies.operationField": "Aktion oder Muster",
    "policies.operationHint":
      "Der Name einer Aktion oder alle Aktionen unter einem Präfix wie connection.crm.*",
    "policies.workspaceField": "Arbeitsbereich",
    "policies.kindField": "Art",
    "policies.valueField": "Richtlinie",
    "policies.actions": "Aktionen",
    "policies.actionsDescription":
      "Jede Aktion dieser Instanz. Öffne eine, um ihre Richtlinie festzulegen und ob Personen sie immer erlauben dürfen.",
    "policies.search": "Aktionen suchen",
    "policies.kindFilter": "Anzeigen",
    "policies.allKinds": "Alle Aktionen",
    "policies.kind.tool": "Agenten-Werkzeuge",
    "policies.kind.connection": "Verbindungen",
    "policies.kind.app": "Apps",
    "policies.kind.workflow": "Workflows",
    "policies.kind.data_store": "Datenspeicher",
    "policies.kind.knowledge_base": "Wissensdatenbanken",
    "policies.kind.platform": "Verwaltung",
    "policies.noMatch": "Keine Aktion passt.",
    "policies.truncated":
      "Einige Aktionen unter {prefix} fehlen in der Liste: Sie liest {limit} davon.",
    "policies.alwaysAllow": "Personen dürfen immer erlauben",
    "policies.alwaysAllowHint":
      "Aus wird jede Person jedes Mal gefragt, auch wo sie vorher „Immer erlauben“ gewählt hat.",
    "policies.alwaysAllowNotForClass":
      "Personen können diese Aktion nicht immer erlauben: Sie lässt sich nicht rückgängig machen oder sendet an andere.",
    "policies.lockedByRelease":
      "Die Release-Konfiguration sperrt „Immer erlauben“ für diese Aktion. Diese Seite kann die Sperre nicht aufheben, nur wer die Instanz betreibt.",
    "policies.lockedByPattern": "Gesperrt durch die Einstellung für {pattern}.",
    "policies.locks": "Sperren für „Immer erlauben“",
    "policies.locksDescription":
      "Aktionen und Muster, die niemand immer erlauben darf. Sperren der Release-Konfiguration stehen hier und lassen sich hier nicht aufheben.",
    "policies.locksEmpty": "Keine Sperren.",
    "policies.lockSource.release": "Release-Konfiguration",
    "policies.lockSource.instance": "Hier festgelegt",
    "policies.unlock": "Aufheben",
    "policies.unlockLabel": "Sperre für {operation} aufheben",
    "policies.lockPattern": "Sperren",
    "policies.refused.policy_names_itself":
      "Die Aktionen der Richtlinien-Seite behalten ihren Standard, damit sich die Richtlinien immer wieder ändern lassen.",
    "policies.refused.unknown_operation":
      "Das nennt keine Aktion dieser Instanz. Nenne eine Aktion genau oder alle Aktionen unter einem Präfix wie connection.crm.*",
    "policies.refused.reading_operation_waits":
      "Diese Aktion liest nur: Sie läuft oder ist aus und fragt niemanden.",
    "policies.refused.locked_by_release":
      "Die Release-Konfiguration sperrt „Immer erlauben“ für diese Aktion. Nur wer die Instanz betreibt, kann das aufheben."
  }
});
