// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/workspace.ts` names.
export const accessWorkspace = defineTranslations({
  en: {
    "access.kindWorkspace": "Building in a workspace",
    "access.actionBuilderDescription":
      "View and edit everything the workspace owns, also what it gets later, and build and try there in private conversations. Deletes nothing. No membership needed: a Builder who is no member sees none of the workspace's conversations.",
    "access.actionPublisherDescription":
      "Publish what the workspace owns. Guardrails and Workflows are not included.",
    "access.scopeWorkspace": "Workspace {name}",
    "access.objectWorkspace": "the workspace {name}"
  },
  de: {
    "access.kindWorkspace": "Bauen in einem Arbeitsbereich",
    "access.actionBuilderDescription":
      "Alles ansehen und bearbeiten, was dem Arbeitsbereich gehört, auch was später dazukommt, und dort in privaten Unterhaltungen bauen und ausprobieren. Löscht nichts. Ohne Mitgliedschaft: wer Builder, aber nicht Mitglied ist, sieht keine Unterhaltung des Arbeitsbereichs.",
    "access.actionPublisherDescription":
      "Veröffentlichen, was dem Arbeitsbereich gehört. Leitplanken und Workflows gehören nicht dazu.",
    "access.scopeWorkspace": "Arbeitsbereich {name}",
    "access.objectWorkspace": "den Arbeitsbereich {name}"
  }
});
