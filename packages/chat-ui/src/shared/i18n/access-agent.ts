// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/agent.ts` names.
export const accessAgent = defineTranslations({
  en: {
    "access.scopeAgent": "Agent {name}",
    "access.kindAgent": "Agents",
    "access.objectAgent": "the agent {name}",
    "access.actionUseAgentDescription": "Chat with the agent where it is available",
    "access.actionApproveAgentDescription":
      "Approve the publish of a workspace's agent that waits in the Inbox"
  },
  de: {
    "access.scopeAgent": "Agent {name}",
    "access.kindAgent": "Agenten",
    "access.objectAgent": "den Agenten {name}",
    "access.actionUseAgentDescription": "Mit dem Agenten chatten, wo er verfügbar ist",
    "access.actionApproveAgentDescription":
      "Die Veröffentlichung eines Agenten eines Arbeitsbereichs freigeben, die im Eingang wartet"
  }
});
