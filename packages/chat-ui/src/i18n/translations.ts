import { access } from "./access";
import { administration } from "./administration";
import { agents } from "./agents";
import { apiAccess } from "./api-access";
import { approvals } from "./approvals";
import { apps } from "./apps";
import { assistant } from "./assistant";
import { build } from "./build";
import { collaborationWorkspace } from "./collaboration-workspace";
import { common } from "./common";
import { configAssets } from "./config-assets";
import { connections } from "./connections";
import { conversation } from "./conversation";
import { dataStores } from "./data-stores";
import { dock } from "./dock";
import { files } from "./files";
import { guardrails } from "./guardrails";
import { inbox } from "./inbox";
import { navigation } from "./navigation";
import { operations } from "./operations";
import { pages } from "./pages";
import { personalApiKeys } from "./personal-api-keys";
import { settings } from "./settings";
import { signIn } from "./sign-in";
import { tools } from "./tools";
import { workflows } from "./workflows";
import { workspace } from "./workspace";
import { combineTranslations } from "./translation-area";

/**
 * Every message of the interface by locale. Each area file owns its keys, and this list is
 * the only way into the dictionary.
 */
export const translations = combineTranslations(common)
  .and(access)
  .and(administration)
  .and(agents)
  .and(apiAccess)
  .and(approvals)
  .and(apps)
  .and(assistant)
  .and(build)
  .and(collaborationWorkspace)
  .and(configAssets)
  .and(connections)
  .and(conversation)
  .and(dataStores)
  .and(dock)
  .and(files)
  .and(guardrails)
  .and(inbox)
  .and(navigation)
  .and(operations)
  .and(pages)
  .and(personalApiKeys)
  .and(settings)
  .and(signIn)
  .and(tools)
  .and(workflows)
  .and(workspace).messages;

export type TranslationKey = keyof (typeof translations)["en"];
