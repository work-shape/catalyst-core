import { access } from "./access";
import { accessAgent } from "./access-agent";
import { accessApp } from "./access-app";
import { accessConnection } from "./access-connection";
import { accessDataStore } from "./access-data-store";
import { accessFeedback } from "./access-feedback";
import { accessUsage } from "./access-usage";
import { usageReports } from "./usage-reports";
import { accessGuardrail } from "./access-guardrail";
import { accessKnowledgeBase } from "./access-knowledge-base";
import { accessJobs } from "./access-jobs";
import { accessMailSender } from "./access-mail-sender";
import { accessRoles } from "./access-roles";
import { accessServicePrincipals } from "./access-service-principals";
import { accessSkill } from "./access-skill";
import { accessSystem } from "./access-system";
import { accessUsers } from "./access-users";
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
import { capabilities } from "./capabilities";
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
import { platformReport } from "./platform-report";
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
import { projectFiles } from "./project-files";
import { projectInstructions } from "./project-instructions";
import { projectSetup } from "./project-setup";
import { projectKnowledge } from "./project-knowledge";
import { projectSettings } from "./project-settings";
import { projects } from "./projects";
import { publishNarrative } from "./publish-narrative";
import { refusals } from "./refusal-texts";
import { rights } from "./rights";
import { scheduled } from "./scheduled";
import { settings } from "./settings";
import { share } from "./share";
import { signIn } from "./sign-in";
import { skillFiles } from "./skill-files";
import { skillImport } from "./skill-import";
import { skillMyChats } from "./skill-my-chats";
import { questions } from "./questions";
import { subagents } from "./subagents";
import { tools } from "./tools";
import { twoFactor } from "./two-factor";
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
  .and(accessUsage)
  .and(accessGuardrail)
  .and(accessKnowledgeBase)
  .and(accessJobs)
  .and(accessMailSender)
  .and(accessRoles)
  .and(accessServicePrincipals)
  .and(accessSkill)
  .and(accessSystem)
  .and(accessUsers)
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
  .and(capabilities)
  .and(collaborationWorkspace)
  .and(configAssets)
  .and(confirmations)
  .and(usageLimits)
  .and(usageReports)
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
  .and(platformReport)
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
  .and(projects)
  .and(projectFiles)
  .and(projectInstructions)
  .and(projectSetup)
  .and(projectKnowledge)
  .and(projectSettings)
  .and(publishNarrative)
  .and(refusals)
  .and(rights)
  .and(scheduled)
  .and(settings)
  .and(share)
  .and(signIn)
  .and(skillFiles)
  .and(skillImport)
  .and(skillMyChats)
  .and(questions)
  .and(subagents)
  .and(tools)
  .and(twoFactor)
  .and(workflowRights)
  .and(workflowDraft)
  .and(workflows)
  .and(workspace).messages;

export type TranslationKey = keyof (typeof translations)["en"];
