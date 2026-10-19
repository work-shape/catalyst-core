import { useState } from "react";
import { Button, RegistryIcon } from "@work-shape/catalyst-ui";
import type { AppSaved } from "../../chat/conversation/subject-run";
import { useTranslation } from "../../shared/i18n";
import { RouteLink } from "../route-link";
import { SharePublishDialog } from "./app-publish-dialog";
import { useAppsHost } from "./apps-host";

/**
 * The line the agent's `app.save` leaves in the conversation (SHARE-1). The first save says the
 * App is saved and its builder can use it now, others once it is shared. A later save says the
 * draft is saved and its builder can use it now; others see the change once it is shared, and
 * the live revision keeps the audience it has. The agent never shares. "Share" opens the App's
 * Publish dialog, which asks "For whom?", for a reader who may publish Apps in the workspace.
 * "Open draft" leads who may write Apps there to the draft's page.
 */
export function AppSavedLine({ saved }: { saved: AppSaved }) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const [sharing, setSharing] = useState(false);
  const workspace = host?.enabled ? host.workspace : undefined;
  const mayOpen = Boolean(workspace && host?.rights.write);
  const mayShare = mayOpen && Boolean(host?.rights.publish);
  return (
    <div
      className="chat-tool-part my-1 flex max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground"
      data-testid="app-saved-line"
    >
      <span className="flex h-4 shrink-0 items-center [&>svg]:size-3.5">
        <RegistryIcon name="app" />
      </span>
      <span className="min-w-0 flex-1">
        {t(saved.created ? "apps.savedLine" : "apps.savedDraftLine", { title: saved.title })}
      </span>
      {host && workspace && mayOpen ? (
        <RouteLink
          route={{ kind: "app-edit", collaborationWorkspaceId: workspace.id, app: saved.name }}
          variant="link"
          className="px-0"
          data-testid="app-saved-open"
          onOpen={(route) => host.showRoute(route)}
        >
          {t("apps.openDraft")}
        </RouteLink>
      ) : null}
      {mayShare ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="app-saved-share"
          disabled={sharing}
          onClick={() => setSharing(true)}
        >
          {t("apps.savedShare")}
        </Button>
      ) : null}
      {sharing ? <SharePublishDialog app={saved.name} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}
