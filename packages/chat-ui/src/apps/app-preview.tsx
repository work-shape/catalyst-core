import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { AppMode, AppPreviewResponse } from "@vivd-catalyst/api-client";
import { Button } from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useTranslation } from "../i18n";
import { LivePagePreview, pageFrameAddress, type PreviewRoute } from "../pages/page-surface";
import { PreviewPane, type PreviewState } from "../pages/preview-pane";
import { useAppAddress } from "./app-data";
import { APP_START_ROUTE, appPreviewProblemText, type AppPreviewProblem } from "./app-model";

/**
 * The state of the pane for what is known of an App's address. `stopped` is an App that is
 * not there for this reader or has nothing published; `failed` is everything that asking
 * again may mend.
 */
export function appPreviewState(input: {
  shown: boolean;
  problem: AppPreviewProblem | undefined;
}): PreviewState {
  if (input.shown) {
    return "ready";
  }
  if (input.problem === undefined) {
    return "starting";
  }
  return input.problem === "not_published" || input.problem === "unavailable"
    ? "stopped"
    : "failed";
}

/**
 * The published or the draft revision of an App in its frame. It asks the instance for the
 * revision's address, shows it in the sandboxed frame every Page is shown in, and answers the
 * App's bridge: the App is told the route of the address when it loads, and tells each route
 * it moves to.
 */
export function AppPreview({
  app,
  mode,
  name,
  appPath,
  turn,
  stoppedAction,
  onNavigate,
  onShown
}: {
  app: string;
  mode: AppMode;
  /** The name people read, for the frame's title. */
  name: string;
  /** The App's own route in the address. Without it the App opens where it starts. */
  appPath?: string;
  /** Counts what changed the revision an address stands for: the address is asked anew. */
  turn?: number;
  /** One action under the sentence of an App that has nothing published, for who may write. */
  stoppedAction?: ReactNode;
  /** The App moved to this route. */
  onNavigate?(path: string): void;
  /** The instance answered with the revision that is shown. */
  onShown?(preview: AppPreviewResponse): void;
}) {
  const { t } = useTranslation();
  const { apiBaseUrl } = useWorkspaceApiClient();
  const address = useAppAddress(app, mode, turn);
  const shown = address.shown;

  const onShownRef = useRef(onShown);
  const onNavigateRef = useRef(onNavigate);
  const pathRef = useRef(appPath);
  useEffect(() => {
    onShownRef.current = onShown;
    onNavigateRef.current = onNavigate;
    pathRef.current = appPath;
  });
  useEffect(() => {
    if (shown) {
      onShownRef.current?.(shown);
    }
  }, [shown]);
  const route = useMemo<PreviewRoute>(
    () => ({
      current: () => pathRef.current ?? APP_START_ROUTE,
      changed: (path) => {
        // The route is the address from here on, so a later load of the frame starts on it.
        pathRef.current = path;
        onNavigateRef.current?.(path);
      }
    }),
    []
  );

  const state = appPreviewState({ shown: shown !== undefined, problem: address.problem });
  if (state === "ready") {
    if (!shown) {
      return null;
    }
    return (
      <LivePagePreview
        title={t("apps.previewOf", { name })}
        pageId={app}
        number={shown.number}
        session={shown.pageSessionId}
        url={pageFrameAddress(shown.url, apiBaseUrl, window.location.href)}
        route={route}
      />
    );
  }
  return (
    <AppPreviewNotice
      state={state}
      mode={mode}
      name={name}
      problem={address.problem}
      stoppedAction={stoppedAction}
      onRetry={address.again}
    />
  );
}

/** What stands in the pane while an App is not shown: on its way, not there, or failed. */
export function AppPreviewNotice({
  state,
  mode,
  name,
  problem,
  stoppedAction,
  onRetry
}: {
  state: PreviewState;
  mode: AppMode;
  name: string;
  problem: AppPreviewProblem | undefined;
  stoppedAction?: ReactNode;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  return (
    <PreviewPane
      source={undefined}
      state={state}
      title={t("apps.previewOf", { name })}
      message={t(problem === undefined ? "apps.starting" : appPreviewProblemText(problem, mode))}
      action={
        state === "failed" ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("tryAgain")}
          </Button>
        ) : problem === "not_published" ? (
          stoppedAction
        ) : undefined
      }
    />
  );
}
