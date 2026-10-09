import { administration } from "./administration";
import { apiAccess } from "./api-access";
import { approvals } from "./approvals";
import { assistant } from "./assistant";
import { collaborationWorkspace } from "./collaboration-workspace";
import { common } from "./common";
import { configAssets } from "./config-assets";
import { conversation } from "./conversation";
import { files } from "./files";
import { navigation } from "./navigation";
import { settings } from "./settings";
import { signIn } from "./sign-in";
import { tools } from "./tools";
import { workspace } from "./workspace";
import { combineTranslations } from "./translation-area";

/**
 * Every message of the interface by locale. Each area file owns its keys, and this list is
 * the only way into the dictionary.
 */
export const translations = combineTranslations(common)
  .and(administration)
  .and(apiAccess)
  .and(approvals)
  .and(assistant)
  .and(collaborationWorkspace)
  .and(configAssets)
  .and(conversation)
  .and(files)
  .and(navigation)
  .and(settings)
  .and(signIn)
  .and(tools)
  .and(workspace).messages;

export type TranslationKey = keyof (typeof translations)["en"];
