// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

/**
 * What the publish of a Workflow says about the rights of the technical accounts it runs as,
 * and the sentences for a publish the instance refused.
 */
export const workflowRights = defineTranslations({
  en: {
    "workflowRights.title": "Rights of the technical accounts",
    "workflowRights.loading": "Checking what the technical accounts may do…",
    "workflowRights.loadFailed":
      "Could not check what the technical accounts may do. The publish checks it again.",
    "workflowRights.allHeld": "The technical accounts hold every right this workflow needs.",
    "workflowRights.runsAs": "{workflow} runs as {account}",
    "workflowRights.childRunsAs": "Child workflow {workflow} runs as {account}",
    "workflowRights.accountMissing": "The technical account “{name}” does not exist.",
    "workflowRights.accountDisabled":
      "The technical account {account} is disabled. Activate it before you publish.",
    "workflowRights.rightOn": "{right}: {asset}",
    "workflowRights.assetUnknownKind": "{name}",
    "workflowRights.assetHidden": "a resource you cannot see",
    "workflowRights.neededToPublish": "Needed to publish",
    "workflowRights.neededToRun": "Needed when it runs",
    "workflowRights.steps": "Steps: {steps}",
    "workflowRights.missingIntro":
      "These rights are missing. Without them the publish is refused, or the steps fail when they run.",
    "workflowRights.notGrantable": "No technical account can be given this right here.",
    "workflowRights.notHeld": "You do not hold this right here yourself, so you cannot give it.",
    "workflowRights.assetUnavailable": "This resource does not exist or is not active.",
    "workflowRights.accountUnavailable": "The technical account is missing or disabled.",
    "workflowRights.notVisible":
      "You cannot see this resource, so you cannot give this right. Ask an admin.",
    "workflowRights.hiddenChild": "A child workflow you cannot see needs rights. Ask an admin.",
    "workflowRights.hiddenChildren":
      "{count} child workflows you cannot see need rights. Ask an admin.",
    "workflowRights.whoGives":
      "Only someone who administers technical accounts and holds these rights can give them, usually an instance admin. Ask them before you publish.",
    "workflowRights.give": "Give {count} rights",
    "workflowRights.giveOne": "Give 1 right",
    "workflowRights.giveConfirm":
      "Give the technical accounts the {count} rights listed above? Each one applies to the one resource named.",
    "workflowRights.giveConfirmButton": "Give rights",
    "workflowRights.giveCancel": "Cancel",
    "workflowRights.given": "The rights were given.",
    "workflowRights.giveFailed": "This right could not be given. Try again.",
    "workflowRights.giveHeld": "Giving this right waits for an approval.",
    "workflowRights.refusedChildUse":
      "The technical account of this workflow may not use the child workflow {workflow}. Give it that right, then publish again.",
    "workflowRights.refusedChildUseUnnamed":
      "The technical account of this workflow may not use a child workflow it starts. Give it that right, then publish again.",
    "workflowRights.refusedNoParentTrigger":
      "The child workflow {workflow} cannot be started by another workflow. Allow that among its triggers, then publish it first.",
    "workflowRights.refusedNoParentTriggerUnnamed":
      "A child workflow cannot be started by another workflow. Allow that among its triggers, then publish it first.",
    "workflowRights.refusedChildUnpublished":
      "A child workflow this workflow starts is not published yet. Publish it first.",
    "workflowRights.refusedCycle": "Publishing this workflow would make it start itself.",
    "workflowRights.refusedAccountMissing":
      "This workflow names a technical account that does not exist on this instance.",
    "workflowRights.refusedAccountUnknown":
      "The technical account “{name}” does not exist on this instance.",
    "workflowRights.refusedAccountDisabled":
      "The technical account “{name}” is disabled. Activate it before you publish.",
    "workflowRights.refusedPersonOnly": "Only a person can publish a workflow.",
    "workflowRights.refusedLends":
      "The workflow runs with the rights of its technical account, so you need each of them yourself to publish it. You lack: {right}."
  },
  de: {
    "workflowRights.title": "Rechte der Technischen Konten",
    "workflowRights.loading": "Prüft, was die Technischen Konten dürfen …",
    "workflowRights.loadFailed":
      "Konnte nicht prüfen, was die Technischen Konten dürfen. Das Veröffentlichen prüft es erneut.",
    "workflowRights.allHeld":
      "Die Technischen Konten haben jedes Recht, das dieser Workflow braucht.",
    "workflowRights.runsAs": "{workflow} läuft als {account}",
    "workflowRights.childRunsAs": "Unter-Workflow {workflow} läuft als {account}",
    "workflowRights.accountMissing": "Das Technische Konto „{name}“ gibt es nicht.",
    "workflowRights.accountDisabled":
      "Das Technische Konto {account} ist deaktiviert. Aktiviere es, bevor du veröffentlichst.",
    "workflowRights.rightOn": "{right}: {asset}",
    "workflowRights.assetUnknownKind": "{name}",
    "workflowRights.assetHidden": "eine Ressource, die du nicht sehen kannst",
    "workflowRights.neededToPublish": "Nötig zum Veröffentlichen",
    "workflowRights.neededToRun": "Nötig, wenn er läuft",
    "workflowRights.steps": "Schritte: {steps}",
    "workflowRights.missingIntro":
      "Diese Rechte fehlen. Ohne sie wird das Veröffentlichen abgelehnt, oder die Schritte schlagen fehl, wenn sie laufen.",
    "workflowRights.notGrantable":
      "Dieses Recht kann hier keinem Technischen Konto gegeben werden.",
    "workflowRights.notHeld":
      "Du hast dieses Recht hier selbst nicht und kannst es deshalb nicht weitergeben.",
    "workflowRights.assetUnavailable": "Diese Ressource gibt es nicht, oder sie ist nicht aktiv.",
    "workflowRights.accountUnavailable": "Das Technische Konto fehlt oder ist deaktiviert.",
    "workflowRights.notVisible":
      "Du kannst diese Ressource nicht sehen und dieses Recht deshalb nicht geben. Bitte einen Admin darum.",
    "workflowRights.hiddenChild":
      "Ein Unter-Workflow, den du nicht sehen kannst, braucht Rechte. Bitte einen Admin darum.",
    "workflowRights.hiddenChildren":
      "{count} Unter-Workflows, die du nicht sehen kannst, brauchen Rechte. Bitte einen Admin darum.",
    "workflowRights.whoGives":
      "Diese Rechte kann nur geben, wer Technische Konten verwaltet und die Rechte selbst hat, meist ein Instanz-Admin. Bitte so jemanden darum, bevor du veröffentlichst.",
    "workflowRights.give": "{count} Rechte geben",
    "workflowRights.giveOne": "1 Recht geben",
    "workflowRights.giveConfirm":
      "Den Technischen Konten die {count} oben genannten Rechte geben? Jedes gilt nur für die eine genannte Ressource.",
    "workflowRights.giveConfirmButton": "Rechte geben",
    "workflowRights.giveCancel": "Abbrechen",
    "workflowRights.given": "Die Rechte wurden vergeben.",
    "workflowRights.giveFailed": "Dieses Recht konnte nicht vergeben werden. Versuche es erneut.",
    "workflowRights.giveHeld": "Das Vergeben dieses Rechts wartet auf eine Freigabe.",
    "workflowRights.refusedChildUse":
      "Das Technische Konto dieses Workflows darf den Unter-Workflow {workflow} nicht verwenden. Gib ihm dieses Recht und veröffentliche dann erneut.",
    "workflowRights.refusedChildUseUnnamed":
      "Das Technische Konto dieses Workflows darf einen Unter-Workflow, den er startet, nicht verwenden. Gib ihm dieses Recht und veröffentliche dann erneut.",
    "workflowRights.refusedNoParentTrigger":
      "Der Unter-Workflow {workflow} kann nicht von einem anderen Workflow gestartet werden. Erlaube das bei seinen Auslösern und veröffentliche ihn dann zuerst.",
    "workflowRights.refusedNoParentTriggerUnnamed":
      "Ein Unter-Workflow kann nicht von einem anderen Workflow gestartet werden. Erlaube das bei seinen Auslösern und veröffentliche ihn dann zuerst.",
    "workflowRights.refusedChildUnpublished":
      "Ein Unter-Workflow, den dieser Workflow startet, ist noch nicht veröffentlicht. Veröffentliche ihn zuerst.",
    "workflowRights.refusedCycle":
      "Würde dieser Workflow veröffentlicht, würde er sich selbst starten.",
    "workflowRights.refusedAccountMissing":
      "Dieser Workflow nennt ein Technisches Konto, das es auf dieser Instanz nicht gibt.",
    "workflowRights.refusedAccountUnknown":
      "Das Technische Konto „{name}“ gibt es auf dieser Instanz nicht.",
    "workflowRights.refusedAccountDisabled":
      "Das Technische Konto „{name}“ ist deaktiviert. Aktiviere es, bevor du veröffentlichst.",
    "workflowRights.refusedPersonOnly": "Nur eine Person kann einen Workflow veröffentlichen.",
    "workflowRights.refusedLends":
      "Der Workflow läuft mit den Rechten seines Technischen Kontos. Um ihn zu veröffentlichen, brauchst du jedes davon selbst. Dir fehlt: {right}."
  }
});
