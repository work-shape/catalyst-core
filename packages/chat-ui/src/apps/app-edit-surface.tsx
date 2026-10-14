import { ExternalLink } from "lucide-react";
import { IconButton } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { openWorkspacePageInNewTab } from "../routes";
import { useApp } from "./app-data";
import { AppPreview } from "./app-preview";
import { useAppsHost } from "./apps-host";

/**
 * The draft of an App beside the conversation in which its agent changes it. The record of the
 * App is read under the key of every asset read, so each save drops it; its new revision asks
 * the instance for a new address, and the frame loads the draft as it is now.
 */
export function AppEditSurface({
  app,
  name,
  workspaceId
}: {
  app: string;
  name: string;
  workspaceId: string | undefined;
}) {
  const read = useApp(workspaceId ?? "", app, workspaceId !== undefined);
  // The first address is asked for the revision that is read, not once before it and again.
  if (read.loading) {
    return null;
  }
  return <AppPreview app={app} mode="draft" name={name} turn={read.app?.revision ?? 0} />;
}

/** Opens the App's page of its draft in a new tab from the head of its surface. */
export function AppEditSurfaceActions({
  app,
  workspaceId
}: {
  app: string;
  workspaceId: string | undefined;
}) {
  const { t } = useTranslation();
  const host = useAppsHost();
  if (host === undefined || workspaceId === undefined) {
    return null;
  }
  return (
    <IconButton
      label={t("apps.surface.openPage")}
      onClick={() =>
        openWorkspacePageInNewTab({ kind: "app-edit", collaborationWorkspaceId: workspaceId, app })
      }
    >
      <ExternalLink aria-hidden="true" />
    </IconButton>
  );
}
