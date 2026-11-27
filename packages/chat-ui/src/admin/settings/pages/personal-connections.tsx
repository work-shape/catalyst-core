import { PageHeader } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../../shared/i18n";
import { MyConnectionsSection } from "../../../studio/build-area/my-connections";

/**
 * You > Connections: everything the person connects with their own account, the same cards as
 * "Meine Verbindungen" on Studio > Connections (CONN-IA). Nobody else sees or uses the
 * person's account or their own servers.
 */
export function PersonalConnectionsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader
        title={t("settings.personalConnections")}
        description={t("myConnections.description")}
      />
      <MyConnectionsSection title={t("myConnections.title")} />
    </>
  );
}
