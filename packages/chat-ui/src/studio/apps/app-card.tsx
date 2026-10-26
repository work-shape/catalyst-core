import { useState } from "react";
import type { AssetSummary } from "@work-shape/catalyst-api-client";
import { Button, Card, IconTile, RegistryIcon } from "@work-shape/catalyst-ui";
import type { AppSaved } from "../../chat/conversation/subject-run";
import { useTranslation } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { RouteLink } from "../route-link";
import { useApp } from "./app-data";
import { appState } from "./app-model";
import { SharePublishDialog } from "./app-publish-dialog";
import { useAppsHost, type AppsHost, type AppsWorkspace } from "./apps-host";

// The App's card in the conversation (APPCARD-1): what the agent's `app.save` made, one card per
// App at its newest save, with its live state, "Open" and "Publish". It replaces the line with
// "Share" (SHARE-1): sharing stays the concept and "For whom?" the dialog's first question; the
// button says what it does. The agent never publishes.

/** Where the App stands for the person, as the card's second line says it. */
export type AppCardState = "saved_only_you" | "draft_saved" | "published";

const STATE_LINES = {
  saved_only_you: "apps.cardSavedOnlyYou",
  draft_saved: "apps.cardDraftSaved",
  published: "apps.cardPublished"
} as const;

/**
 * The state of the App as its record reads now: never published, a draft ahead of what is
 * live, or the draft live. Until the record is read the save itself says it: the save that
 * made the App, or a later draft.
 */
export function appCardState(
  app: Pick<AssetSummary, "revision" | "draftRevision" | "publishedRevision"> | undefined,
  saved: Pick<AppSaved, "created">
): AppCardState {
  if (app === undefined) return saved.created ? "saved_only_you" : "draft_saved";
  const state = appState(app);
  if (state.kind === "draft_only") return "saved_only_you";
  return state.draftAhead ? "draft_saved" : "published";
}

/** The card of the newest save of an App. */
export function AppCard({ saved }: { saved: AppSaved }) {
  const host = useAppsHost();
  const workspace = host?.enabled ? host.workspace : undefined;
  // Outside a workspace shell nothing reads the App: the card says what the save said.
  return host && workspace ? (
    <LiveAppCard saved={saved} host={host} workspace={workspace} />
  ) : (
    <AppCardView saved={saved} state={appCardState(undefined, saved)} />
  );
}

function LiveAppCard({
  saved,
  host,
  workspace
}: {
  saved: AppSaved;
  host: AppsHost;
  workspace: AppsWorkspace;
}) {
  const { t } = useTranslation();
  const [publishing, setPublishing] = useState(false);
  const mayOpen = host.rights.write;
  // The App's record, read again once a publish wrote it: the card then says "Published".
  const live = useApp(workspace.id, saved.name, true);
  const state = appCardState(live.app, saved);
  const tell = host.tellConversation;
  return (
    <>
      <AppCardView
        saved={saved}
        state={state}
        {...(mayOpen
          ? {
              open: {
                route: {
                  kind: "app-edit",
                  collaborationWorkspaceId: workspace.id,
                  app: saved.name
                },
                onOpen: (route: WorkspaceRoute) => host.showRoute(route)
              }
            }
          : {})}
        {...(mayOpen && host.rights.publish && state !== "published"
          ? { publishing, onPublish: () => setPublishing(true) }
          : {})}
      />
      {publishing ? (
        <SharePublishDialog
          app={saved.name}
          onClose={() => setPublishing(false)}
          // The agent of the conversation goes on from the publish, without a message typed.
          {...(tell
            ? {
                onPublished: () => {
                  tell(t("apps.cardPublishedTell", { title: saved.title })).catch(() => undefined);
                }
              }
            : {})}
        />
      ) : null}
    </>
  );
}

/** The card as it shows one App: its name, its state and the actions its reader may take. */
export function AppCardView({
  saved,
  state,
  open,
  publishing = false,
  onPublish
}: {
  saved: AppSaved;
  state: AppCardState;
  /** The draft's page, for a reader who may write Apps. */
  open?: { route: WorkspaceRoute; onOpen(route: WorkspaceRoute): void };
  /** The Publish dialog is open. */
  publishing?: boolean;
  /** Opens the Publish dialog, for a reader who may publish while the draft is not live. */
  onPublish?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <Card
        padding="md"
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
        role="group"
        aria-label={saved.title}
        data-testid="app-card"
        data-app={saved.name}
        data-state={state}
      >
        <IconTile>
          <RegistryIcon name="app" />
        </IconTile>
        <div className="grid min-w-0 flex-1 basis-40 gap-0.5">
          <p className="truncate text-label text-foreground">{saved.title}</p>
          {/* The state is read whole: at phone width it takes a second line, never an ellipsis. */}
          <p className="text-caption text-muted-foreground" data-testid="app-card-state">
            {t(STATE_LINES[state])}
          </p>
        </div>
        {open || onPublish ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {open ? (
              <RouteLink
                route={open.route}
                variant="outline"
                data-testid="app-card-open"
                onOpen={open.onOpen}
              >
                {t("apps.open")}
              </RouteLink>
            ) : null}
            {onPublish ? (
              <Button
                size="sm"
                data-testid="app-card-publish"
                disabled={publishing}
                onClick={onPublish}
              >
                {t("apps.publish")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
