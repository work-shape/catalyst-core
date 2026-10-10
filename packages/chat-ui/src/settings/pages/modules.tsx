import { Lock } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { InstanceModule } from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  PageHeader,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../../i18n";
import { useSettingsPage } from "../settings-page-context";

/** The name and the one line of each module the product knows. A later module adds its pair. */
const moduleTexts: Partial<Record<string, { name: TranslationKey; description: TranslationKey }>> =
  {
    documents: { name: "modules.documents", description: "modules.documentsDescription" },
    resources: { name: "modules.resources", description: "modules.resourcesDescription" },
    assetManagement: {
      name: "modules.assetManagement",
      description: "modules.assetManagementDescription"
    },
    userInvitations: {
      name: "modules.userInvitations",
      description: "modules.userInvitationsDescription"
    }
  };

/**
 * Instance > Modules: which optional features this instance runs. The switch of a module is
 * release config, so the page has none: it says where the switch is.
 */
export function ModulesPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const modulesQuery = useQuery({
    queryKey: ["instance-modules", apiBaseUrl, authScope],
    queryFn: async () => (await client.instance.modules.list()).items
  });
  const modules = modulesQuery.data;

  return (
    <>
      <PageHeader title={t("modules.title")} description={t("modules.description")} />
      <div className="grid gap-4">
        <OperatorManaged />
        {modules ? (
          <ModuleTable modules={modules} />
        ) : modulesQuery.error ? (
          <Banner tone="danger">{t("modules.loadFailed")}</Banner>
        ) : (
          <SkeletonList rows={4} />
        )}
      </div>
    </>
  );
}

/**
 * Says that the operator sets what the page shows and that nothing here can be changed. It is
 * the one place this page marks that, so a shared marking for operator-managed values can
 * take its place.
 */
function OperatorManaged() {
  const { t } = useTranslation();
  return (
    <Banner layout="line" icon={<Lock aria-hidden="true" />} data-operator-managed="">
      {t("modules.operatorManaged")}
    </Banner>
  );
}

function ModuleTable({ modules }: { modules: readonly InstanceModule[] }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("modules.module")}</TableHead>
          <TableHead>{t("modules.state")}</TableHead>
          <TableHead>{t("modules.contributes")}</TableHead>
          <TableHead>{t("modules.configKey")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {modules.map((module) => {
          const texts = moduleTexts[module.name];
          return (
            <TableRow key={module.name} data-module={module.name}>
              <TableCell>
                {texts ? t(texts.name) : module.name}
                {texts ? (
                  <div className="mt-1 text-caption text-muted-foreground">
                    {t(texts.description)}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Badge tone={module.enabled ? "success" : "neutral"} dot>
                  {t(module.enabled ? "modules.on" : "modules.off")}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                <Contributions module={module} />
              </TableCell>
              <TableCell className="font-mono whitespace-nowrap">{module.configKey}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** What the module adds while it is on: its kinds and job kinds by name, the rest counted. */
function Contributions({ module }: { module: InstanceModule }) {
  const { t, locale } = useTranslation();
  if (!module.shipped) {
    return t("modules.notShipped");
  }
  const parts = [
    module.kinds.length > 0 ? t("modules.kinds", { kinds: module.kinds.join(", ") }) : undefined,
    module.operationCount > 0
      ? t("modules.operations", { count: module.operationCount.toLocaleString(locale) })
      : undefined,
    module.jobKinds.length > 0
      ? t("modules.jobKinds", { kinds: module.jobKinds.join(", ") })
      : undefined,
    module.toolCount > 0
      ? t("modules.tools", { count: module.toolCount.toLocaleString(locale) })
      : undefined
  ].filter((part) => part !== undefined);
  if (parts.length === 0) {
    return t("modules.interfaceOnly");
  }
  return (
    <ul className="grid gap-1">
      {parts.map((part) => (
        <li key={part}>{part}</li>
      ))}
    </ul>
  );
}
