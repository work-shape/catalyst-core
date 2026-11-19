// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/tool.ts` names.
export const accessTool = defineTranslations({
  en: {
    "access.actionReadToolDescription": "See the tool, its input and its result.",
    "access.actionWriteToolDescription":
      "Change the draft of the tool. Agents get a draft only once it is published.",
    "access.actionPublishToolDescription": "Make a draft the version agents call.",
    "access.actionApproveToolDescription": "Approve a held publish of the tool in the Inbox.",
    "access.actionDeleteToolDescription":
      "Delete the tool. A tool an agent still names cannot be deleted.",
    "access.scopeTool": "Tool {name}",
    "access.scopeOnTool": "On one tool",
    "access.scopeOnToolDescription": "One existing tool.",
    "access.grantTool": "Tool",
    "access.chooseTool": "Choose a tool",
    "access.noTools": "There is no tool yet.",
    "access.toolsLoadFailed": "The tools could not be loaded.",
    "access.kindTool": "Tools",
    "access.objectTool": "the tool {name}"
  },
  de: {
    "access.actionReadToolDescription": "Das Werkzeug, seine Eingabe und sein Ergebnis sehen.",
    "access.actionWriteToolDescription":
      "Den Entwurf des Werkzeugs ändern. Agenten bekommen einen Entwurf erst, wenn er veröffentlicht ist.",
    "access.actionPublishToolDescription":
      "Einen Entwurf zu der Version machen, die Agenten aufrufen.",
    "access.actionApproveToolDescription":
      "Eine zurückgehaltene Veröffentlichung des Werkzeugs im Posteingang freigeben.",
    "access.actionDeleteToolDescription":
      "Das Werkzeug löschen. Ein Werkzeug, das ein Agent noch nennt, lässt sich nicht löschen.",
    "access.scopeTool": "Werkzeug {name}",
    "access.scopeOnTool": "An einem Werkzeug",
    "access.scopeOnToolDescription": "Ein vorhandenes Werkzeug.",
    "access.grantTool": "Werkzeug",
    "access.chooseTool": "Werkzeug wählen",
    "access.noTools": "Es gibt noch kein Werkzeug.",
    "access.toolsLoadFailed": "Die Werkzeuge konnten nicht geladen werden.",
    "access.kindTool": "Werkzeuge",
    "access.objectTool": "das Werkzeug {name}"
  }
});
