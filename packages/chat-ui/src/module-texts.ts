import { useTranslation, type TranslationKey } from "./i18n";

/** The name and the one line of each module the product knows. A later module adds its pair. */
export const moduleTexts: Partial<
  Record<string, { name: TranslationKey; description: TranslationKey }>
> = {
  documents: { name: "modules.documents", description: "modules.documentsDescription" },
  resources: { name: "modules.resources", description: "modules.resourcesDescription" },
  assetManagement: {
    name: "modules.assetManagement",
    description: "modules.assetManagementDescription"
  },
  userInvitations: {
    name: "modules.userInvitations",
    description: "modules.userInvitationsDescription"
  },
  apps: { name: "modules.apps", description: "modules.appsDescription" }
};

/** The name of a module as the interface says it, or the config name of one it does not know. */
export function useModuleName(): (module: string) => string {
  const { t } = useTranslation();
  return (module) => {
    const texts = moduleTexts[module];
    return texts ? t(texts.name) : module;
  };
}
