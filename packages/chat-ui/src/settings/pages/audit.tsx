import { useWorkspaceAuditActivitiesQuery } from "../../api/workspace-queries";
import { AuditView } from "../../control-plane/audit-view";
import { apiErrorMessage } from "../../workspace-utils";
import { useSettingsPage } from "../settings-page-context";

/** Instance > Audit: who changed what, with its own data. */
export function AuditPage() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const auditQuery = useWorkspaceAuditActivitiesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });

  return (
    <AuditView
      auditActivities={auditQuery.data}
      error={auditQuery.error ? apiErrorMessage(auditQuery.error, undefined) : undefined}
    />
  );
}
