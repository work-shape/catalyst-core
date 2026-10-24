import { access } from "./access";
import { accessAgent } from "./access-agent";
import { accessApp } from "./access-app";
import { accessConnection } from "./access-connection";
import { accessDataStore } from "./access-data-store";
import { accessFeedback } from "./access-feedback";
import { accessGuardrail } from "./access-guardrail";
import { accessKnowledgeBase } from "./access-knowledge-base";
import { accessMailSender } from "./access-mail-sender";
import { accessRoles } from "./access-roles";
import { accessSkill } from "./access-skill";
import { accessWorkflow } from "./access-workflow";
import { accessWorkspace } from "./access-workspace";
import { administration } from "./administration";
import { agentDraft } from "./agent-draft";
import { agents } from "./agents";
import { apiAccess } from "./api-access";
import { approvals } from "./approvals";
import { apps } from "./apps";
import { assistant } from "./assistant";
import { audit } from "./audit";
import { build } from "./build";
import { collaborationWorkspace } from "./collaboration-workspace";
import { common } from "./common";
import { configAssets } from "./config-assets";
import { confirmations } from "./confirmations";
import { usageLimits } from "./usage-limits";
import { connectionCatalogue } from "./connection-catalogue";
import { connectionCreate } from "./connection-create";
import { connectionTyped } from "./connection-typed";
import { knowledgeSources } from "./knowledge-sources";
import { connectionGive } from "./connection-give";
import { connectionPage } from "./connection-page";
import { connectionSignIn } from "./connection-sign-in";
import { connections } from "./connections";
import { conversation } from "./conversation";
import { dataStores } from "./data-stores";
import { dock } from "./dock";
import { feedback } from "./feedback";
import { files } from "./files";
import { guardrails } from "./guardrails";
import { inbox } from "./inbox";
import { knowledge } from "./knowledge";
import { localAgent } from "./local-agent";
import { navigation } from "./navigation";
import { operations } from "./operations";
import { pages } from "./pages";
import { personalApiKeys } from "./personal-api-keys";
import { personalConnections } from "./personal-connections";
import { publishNarrative } from "./publish-narrative";
import { rights } from "./rights";
import { scheduled } from "./scheduled";
import { settings } from "./settings";
import { signIn } from "./sign-in";
import { skillFiles } from "./skill-files";
import { skillImport } from "./skill-import";
import { subagents } from "./subagents";
import { tools } from "./tools";
import { workflowDraft } from "./workflow-draft";
import { workflowRights } from "./workflow-rights";
import { workflows } from "./workflows";
import { workspace } from "./workspace";
import { combineTranslations } from "./translation-area";

/**
 * Every message of the interface by locale. Each area file owns its keys, and this list is
 * the only way into the dictionary.
 */
export const translations = combineTranslations(common)
  .and(access)
  .and(accessAgent)
  .and(accessApp)
  .and(accessConnection)
  .and(accessDataStore)
  .and(accessFeedback)
  .and(accessGuardrail)
  .and(accessKnowledgeBase)
  .and(accessMailSender)
  .and(accessRoles)
  .and(accessSkill)
  .and(accessWorkflow)
  .and(accessWorkspace)
  .and(administration)
  .and(agentDraft)
  .and(agents)
  .and(apiAccess)
  .and(approvals)
  .and(apps)
  .and(assistant)
  .and(audit)
  .and(build)
  .and(collaborationWorkspace)
  .and(configAssets)
  .and(confirmations)
  .and(usageLimits)
  .and(connectionCatalogue)
  .and(connectionCreate)
  .and(connectionGive)
  .and(connectionPage)
  .and(connectionSignIn)
  .and(connectionTyped)
  .and(knowledgeSources)
  .and(connections)
  .and(conversation)
  .and(dataStores)
  .and(dock)
  .and(feedback)
  .and(files)
  .and(guardrails)
  .and(inbox)
  .and(knowledge)
  .and(localAgent)
  .and(navigation)
  .and(operations)
  .and(pages)
  .and(personalApiKeys)
  .and(personalConnections)
  .and(publishNarrative)
  .and(rights)
  .and(scheduled)
  .and(settings)
  .and(signIn)
  .and(skillFiles)
  .and(skillImport)
  .and(subagents)
  .and(tools)
  .and(workflowRights)
  .and(workflowDraft)
  .and(workflows)
  .and(workspace).messages;

export type TranslationKey = keyof (typeof translations)["en"];
