// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/knowledge-base.ts` names.
export const accessKnowledgeBase = defineTranslations({
  en: {
    "access.actionReadKnowledgeBaseDescription":
      "See the Knowledge Base, the tables it describes and whether they can be read.",
    "access.actionUseKnowledgeBaseDescription":
      "Get answers from its documents: in chat through an agent that has it, and with a test search. This person needs no further right for that.",
    "access.actionWriteKnowledgeBaseDescription":
      "Change the draft of the Knowledge Base. A draft answers nobody until it is published.",
    "access.actionPublishKnowledgeBaseDescription":
      "Make a draft the version that answers. Publishing also needs the right to read the Data Store behind it.",
    "access.scopeKnowledgeBase": "Knowledge Base {name}",
    "access.scopeOnKnowledgeBase": "On one Knowledge Base",
    "access.scopeOnKnowledgeBaseDescription": "One existing Knowledge Base.",
    "access.grantKnowledgeBase": "Knowledge Base",
    "access.chooseKnowledgeBase": "Choose a Knowledge Base",
    "access.noKnowledgeBases": "This instance has no Knowledge Base yet.",
    "access.knowledgeBasesLoadFailed": "The Knowledge Bases could not be loaded.",
    "access.kindKnowledgeBase": "Knowledge bases",
    "access.objectKnowledgeBase": "the Knowledge Base {name}",
    "access.actionDeleteKnowledgeBaseDescription":
      "Delete the Knowledge Base. Documents it keeps itself are deleted with it; a Data Store it describes stays as it is."
  },
  de: {
    "access.actionReadKnowledgeBaseDescription":
      "Die Wissensbasis sehen, die Tabellen, die sie beschreibt, und ob sie sich lesen lassen.",
    "access.actionUseKnowledgeBaseDescription":
      "Antworten aus ihren Dokumenten bekommen: im Chat über einen Agenten, der sie hat, und mit einer Testsuche. Dafür braucht die Person kein weiteres Recht.",
    "access.actionWriteKnowledgeBaseDescription":
      "Den Entwurf der Wissensbasis ändern. Ein Entwurf antwortet niemandem, bis er veröffentlicht ist.",
    "access.actionPublishKnowledgeBaseDescription":
      "Einen Entwurf zu der Version machen, die antwortet. Veröffentlichen braucht zusätzlich das Recht, den Datenspeicher dahinter zu lesen.",
    "access.scopeKnowledgeBase": "Wissensbasis {name}",
    "access.scopeOnKnowledgeBase": "An einer Wissensbasis",
    "access.scopeOnKnowledgeBaseDescription": "Eine vorhandene Wissensbasis.",
    "access.grantKnowledgeBase": "Wissensbasis",
    "access.chooseKnowledgeBase": "Wissensbasis wählen",
    "access.noKnowledgeBases": "Auf dieser Instanz gibt es noch keine Wissensbasis.",
    "access.knowledgeBasesLoadFailed": "Die Wissensbasen konnten nicht geladen werden.",
    "access.kindKnowledgeBase": "Wissensbasen",
    "access.objectKnowledgeBase": "die Wissensbasis {name}",
    "access.actionDeleteKnowledgeBaseDescription":
      "Die Wissensbasis löschen. Dokumente, die sie selbst hält, werden mit ihr gelöscht; ein Datenspeicher, den sie beschreibt, bleibt, wie er ist."
  }
});
