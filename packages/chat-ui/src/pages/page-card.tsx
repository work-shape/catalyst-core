import { AppWindow, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  Button,
  Card,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Spinner
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { useToolDisplayPanel } from "../tool-display-panel";
import { usePageConversationId } from "./page-host";
import {
  buildErrorCountLabel,
  pageSurface,
  pageSurfaceAfterRunCalls,
  readPageSave,
  type PageSave
} from "./page-save";
import { BuildErrorList } from "./page-surface";

/**
 * The card of one `page.save` call in the thread. A stored revision reopens beside the
 * conversation from here; a refused save shows what the build found. A save that wrote the
 * draft of the App the conversation is about says so, and the App is shown as the App.
 */
export function PageSaveCard({
  args,
  result,
  failed
}: {
  args: unknown;
  result: unknown;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const panel = useToolDisplayPanel();
  const conversationId = usePageConversationId();
  const save = readPageSave({ args, result, failed });
  const surface =
    save.state === "built" && conversationId !== undefined && panel.available
      ? pageSurface(conversationId, save, t)
      : undefined;

  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <PageSaveCardView
        save={save}
        shown={surface !== undefined && panel.open && panel.entry?.key === surface.key}
        onOpen={surface ? () => panel.show(surface) : undefined}
      />
    </div>
  );
}

/** The card by the state of its save. */
export function PageSaveCardView({
  save,
  shown,
  onOpen
}: {
  save: PageSave;
  /** This revision is the one the surface slot holds. */
  shown: boolean;
  /** Opens the revision beside the conversation. Absent where there is no slot to open it in. */
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const name = save.name ?? t("pages.unnamed");

  if (save.state === "built") {
    return (
      <Card
        className="flex min-w-0 items-center gap-3 px-4 py-3 text-body"
        data-testid="page-card"
        data-state="built"
        role="group"
        aria-label={name}
      >
        <AppWindow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate font-medium text-foreground">{name}</p>
          <p className="truncate text-caption text-muted-foreground">
            {save.app?.saved === true
              ? t("pages.savedToApp", { number: save.number, title: save.app.title })
              : t("pages.revision", { number: save.number })}
          </p>
          {save.app?.saved === false ? (
            <p className="text-caption text-muted-foreground" data-testid="page-card-app-note">
              {t("pages.notSavedToApp", { title: save.app.title })}
            </p>
          ) : null}
        </div>
        {save.app?.saved === true ? null : shown ? (
          <span className="shrink-0 text-caption text-muted-foreground">{t("pages.shown")}</span>
        ) : onOpen ? (
          <Button type="button" size="sm" variant="outline" onClick={onOpen}>
            {t("pages.open")}
          </Button>
        ) : null}
      </Card>
    );
  }

  if (save.state === "building") {
    return (
      <Card
        className="flex min-w-0 items-center gap-3 px-4 py-3 text-body text-muted-foreground"
        data-testid="page-card"
        data-state="building"
        role="status"
      >
        <Spinner />
        <p className="min-w-0 truncate">
          <span className="font-medium text-foreground">{name}</span>
          <span className="ml-2">{t("pages.cardBuilding")}</span>
        </p>
      </Card>
    );
  }

  return (
    <Card
      className="grid min-w-0 gap-1 px-4 py-3 text-body"
      data-testid="page-card"
      data-state={save.state}
      role="group"
      aria-label={name}
    >
      <div className="flex min-w-0 items-center gap-3">
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate font-medium text-foreground">{name}</p>
          <p className="text-caption text-muted-foreground">
            {t(save.state === "errors" ? "pages.cardErrors" : "pages.cardFailed")}
          </p>
        </div>
      </div>
      {save.state === "errors" && save.errors.length > 0 ? (
        <Disclosure className="pl-7">
          <DisclosureTrigger>{buildErrorCountLabel(save.errors.length, t)}</DisclosureTrigger>
          <p className="pb-1 text-caption text-muted-foreground">
            {t(
              save.errors.length === 1 ? "pages.errorsNothingSavedOne" : "pages.errorsNothingSaved"
            )}
          </p>
          <DisclosureContent>
            <BuildErrorList errors={save.errors} />
          </DisclosureContent>
        </Disclosure>
      ) : null}
    </Card>
  );
}

interface WatchedRun {
  run: { id: string };
  projection: {
    status: string;
    parts: readonly {
      type: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
      state?: string;
    }[];
  };
}

const FINISHED_RUN_STATES = new Set(["completed", "failed", "cancelled"]);

/**
 * Shows a Page beside the conversation when a run saves it: from the start of the save, as the
 * Page that builds, and then its revision. Only a run seen while it was going counts, so opening
 * a conversation whose Page was built earlier opens nothing: its card does. Each revision opens
 * by itself once, however often the calls of its run are seen again. A save the build refused
 * puts its findings under the revision of that Page that is shown. Where the conversation is
 * about an App (`aboutApp`), its saves are seen as the App and open no Page.
 */
export function useAutoOpenPageSurface(
  activeRun: WatchedRun | undefined,
  conversationId: string | undefined,
  aboutApp = false
): void {
  const panel = useToolDisplayPanel();
  const { t } = useTranslation();
  const watchedRunIds = useRef(new Set<string>());
  const handledCalls = useRef(new Set<string>());

  useEffect(() => {
    if (!activeRun || conversationId === undefined || !panel.available) {
      return;
    }
    const runId = activeRun.run.id;
    if (!watchedRunIds.current.has(runId)) {
      if (FINISHED_RUN_STATES.has(activeRun.projection.status)) {
        return;
      }
      watchedRunIds.current.add(runId);
    }
    const next = pageSurfaceAfterRunCalls({
      conversationId,
      parts: activeRun.projection.parts,
      handled: handledCalls.current,
      current: panel.open ? panel.entry : undefined,
      aboutApp,
      t
    });
    if (!next) {
      return;
    }
    if (panel.open && panel.entry?.key === next.key) {
      // The revision or the building Page that is shown gets what the run found for it.
      panel.show(next);
    } else {
      // A revision opens by itself once. Coming back to the conversation while its run is
      // still ending replays the run's calls, and they open nothing a second time.
      panel.showOnce(next);
    }
  }, [aboutApp, activeRun, conversationId, panel, t]);
}
