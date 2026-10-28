// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/workflow.ts` names.
export const accessWorkflow = defineTranslations({
  en: {
    "access.actionReadWorkflowDescription": "See the Workflow, its steps and its runs.",
    "access.actionUseWorkflowDescription":
      "Start the Workflow. It then runs with the Workflow's own rights, not with this person's, so it can read and change what the person cannot.",
    "access.actionWriteWorkflowDescription":
      "Change the draft of the Workflow. A draft does not run until it is published.",
    "access.actionPublishWorkflowDescription": "Make a draft the version that runs.",
    "access.actionPublishWorkflowNote":
      "Publishing also needs every right of the service principal the Workflow runs as. Whoever lacks one of them is refused, with the right named.",
    "access.scopeWorkflow": "Workflow {name}",
    "access.scopeOnWorkflow": "On one Workflow",
    "access.scopeOnWorkflowDescription": "One existing Workflow.",
    "access.grantWorkflow": "Workflow",
    "access.chooseWorkflow": "Choose a Workflow",
    "access.noWorkflows": "There is no Workflow yet.",
    "access.workflowsLoadFailed": "The Workflows could not be loaded.",
    "access.kindWorkflow": "Workflows",
    "access.objectWorkflow": "the Workflow {name}",
    "access.actionReadRunData": "Read run data",
    "access.actionReadRunDataWorkflowDescription":
      "Reserved for downloading run datasets. Today this right gives no access beyond View.",
    "access.actionReadRunDataWorkflowNote":
      "Giving this reserved right already requires every right of the service principals named in the Workflow's draft and published versions.",
    "access.actionDeleteWorkflowDescription": "Delete the Workflow. Its runs stay readable."
  },
  de: {
    "access.actionReadWorkflowDescription": "Den Workflow, seine Schritte und seine Läufe sehen.",
    "access.actionUseWorkflowDescription":
      "Den Workflow starten. Er läuft dann mit den eigenen Rechten des Workflows, nicht mit denen dieser Person, und kann deshalb lesen und ändern, was die Person nicht darf.",
    "access.actionWriteWorkflowDescription":
      "Den Entwurf des Workflows ändern. Ein Entwurf läuft erst, wenn er veröffentlicht ist.",
    "access.actionPublishWorkflowDescription": "Einen Entwurf zu der Version machen, die läuft.",
    "access.actionPublishWorkflowNote":
      "Zum Veröffentlichen braucht die Person außerdem jedes Recht des Technischen Kontos, als das der Workflow läuft. Fehlt ihr eines, wird sie abgelehnt, mit dem fehlenden Recht beim Namen.",
    "access.scopeWorkflow": "Workflow {name}",
    "access.scopeOnWorkflow": "An einem Workflow",
    "access.scopeOnWorkflowDescription": "Ein vorhandener Workflow.",
    "access.grantWorkflow": "Workflow",
    "access.chooseWorkflow": "Workflow wählen",
    "access.noWorkflows": "Es gibt noch keinen Workflow.",
    "access.workflowsLoadFailed": "Die Workflows konnten nicht geladen werden.",
    "access.kindWorkflow": "Workflows",
    "access.objectWorkflow": "den Workflow {name}",
    "access.actionReadRunData": "Laufdaten lesen",
    "access.actionReadRunDataWorkflowDescription":
      "Für den Download von Laufdatensätzen vorgesehen. Heute gibt dieses Recht keinen zusätzlichen Zugriff über Ansehen hinaus.",
    "access.actionReadRunDataWorkflowNote":
      "Zum Vergeben brauchst du bereits jedes Recht der technischen Konten des Workflow-Entwurfs und der veröffentlichten Version.",
    "access.actionDeleteWorkflowDescription": "Den Workflow löschen. Seine Läufe bleiben lesbar."
  }
});
