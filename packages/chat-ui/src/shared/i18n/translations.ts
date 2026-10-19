import { access } from "./access";
import { accessKinds } from "./access-kinds";
import { administration } from "./administration";
import { agentDraft } from "./agent-draft";
import { agents } from "./agents";
import { apiAccess } from "./api-access";
import { approvals } from "./approvals";
import { apps } from "./apps";
import { assistant } from "./assistant";
import { build } from "./build";
import { collaborationWorkspace } from "./collaboration-workspace";
import { common } from "./common";
import { configAssets } from "./config-assets";
import { connectionCreate } from "./connection-create";
import { connectionGive } from "./connection-give";
import { connectionPage } from "./connection-page";
import { connectionSignIn } from "./connection-sign-in";
import { connections } from "./connections";
import { conversation } from "./conversation";
import { dataStores } from "./data-stores";
import { dock } from "./dock";
import { files } from "./files";
import { guardrails } from "./guardrails";
import { inbox } from "./inbox";
import { knowledge } from "./knowledge";
import { localAgent } from "./local-agent";
import { navigation } from "./navigation";
import { operations } from "./operations";
import { pages } from "./pages";
import { personalApiKeys } from "./personal-api-keys";
import { publishNarrative } from "./publish-narrative";
import { rights } from "./rights";
import { settings } from "./settings";
import { signIn } from "./sign-in";
import { skillFiles } from "./skill-files";
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
  .and(accessKinds)
  .and(administration)
  .and(agentDraft)
  .and(agents)
  .and(apiAccess)
  .and(approvals)
  .and(apps)
  .and(assistant)
  .and(build)
  .and(collaborationWorkspace)
  .and(configAssets)
  .and(connectionCreate)
  .and(connectionGive)
  .and(connectionPage)
  .and(connectionSignIn)
  .and(connections)
  .and(conversation)
  .and(dataStores)
  .and(dock)
  .and(files)
  .and(guardrails)
  .and(inbox)
  .and(knowledge)
  .and(localAgent)
  .and(navigation)
  .and(operations)
  .and(pages)
  .and(personalApiKeys)
  .and(publishNarrative)
  .and(rights)
  .and(settings)
  .and(signIn)
  .and(skillFiles)
  .and(subagents)
  .and(tools)
  .and(workflowRights)
  .and(workflowDraft)
  .and(workflows)
  .and(workspace).messages;

export type TranslationKey = keyof (typeof translations)["en"];
