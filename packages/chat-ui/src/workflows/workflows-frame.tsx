import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import {
  Badge,
  Button,
  InlineError,
  PageHeaderBack,
  Skeleton,
  Spinner
} from "@work-shape/catalyst-ui";
import { opensHere } from "../apps/app-header";
import { formatElapsed } from "../control-plane/locale-format";
import { useTranslation, type TranslationContextValue } from "../i18n";
import { workspaceRoutePath } from "../routes";
import type { WorkspaceRoute } from "../workspace/workspace-route";
import type { WorkflowRunStatus } from "./workflow-views";
import { runStatePresentation } from "./workflow-model";

/** Goes to a route of the interface. */
export type OpenRoute = (route: WorkspaceRoute) => void;

/** What a link to a route carries: its address, and a plain click that opens it here. */
export function routeLink(route: WorkspaceRoute, open: OpenRoute) {
  return {
    href: workspaceRoutePath(route),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (opensHere(event)) {
        event.preventDefault();
        open(route);
      }
    }
  };
}

/**
 * The frame of a page of the Workflows area: the landmark and the one element that scrolls.
 * Below `md` the button that opens the sidebar floats over the page. A list starts below it;
 * a page with a pinned head starts at the top edge with its first row beside the button.
 * The title takes the focus when the page opens, as on every full page.
 */
export function WorkflowsFrame({
  label,
  testId,
  pinnedHead = false,
  fill = false,
  children
}: {
  /** Names the landmark. */
  label: string;
  testId: string;
  pinnedHead?: boolean;
  /**
   * The page does not scroll: its head rests at the top and what follows takes the room that
   * is left, such as a canvas.
   */
  fill?: boolean;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const title = scrollRef.current?.querySelector("h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, []);
  return (
    <section
      aria-label={label}
      data-testid={testId}
      className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] bg-background"
    >
      <div
        ref={scrollRef}
        className={
          fill
            ? "flex min-h-0 min-w-0 flex-col overflow-hidden [container-type:size] max-md:[--layout-page-head-inset:0rem] max-md:[--layout-page-head-start:var(--layout-header-control)] max-md:[--layout-page-inset:var(--layout-header)]"
            : pinnedHead
              ? "min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [container-type:size] max-md:[--layout-page-head-inset:0rem] max-md:[--layout-page-head-start:var(--layout-header-control)] max-md:[--layout-page-inset:var(--layout-header)]"
              : "min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [container-type:size] max-md:[--layout-page-inset:var(--layout-header)]"
        }
      >
        {children}
      </div>
    </section>
  );
}

/** The way back in the head of a page: an arrow with where it leads. */
export function BackLink({
  route,
  label,
  children,
  onOpenRoute
}: {
  route: WorkspaceRoute;
  /** Names the link for someone who does not see its text. */
  label: string;
  children: ReactNode;
  onOpenRoute: OpenRoute;
}) {
  return (
    <PageHeaderBack label={label} {...routeLink(route, onOpenRoute)}>
      {children}
    </PageHeaderBack>
  );
}

/**
 * What stands for the title of a page while its record loads: a bar where the name will be.
 * `children` name the page meanwhile for someone who does not see the bar.
 */
export function TitlePlaceholder({ children }: { children: string }) {
  return (
    <>
      <Skeleton className="w-48" />
      <span className="sr-only">{children}</span>
    </>
  );
}

/** A read that failed, with the way to ask again. */
export function LoadError({ children, onRetry }: { children: ReactNode; onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <InlineError className="flex flex-wrap items-center justify-between gap-2">
      <span>{children}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("tryAgain")}
      </Button>
    </InlineError>
  );
}

/** The state of a run as a badge. A run that is going carries a spinner in place of the dot. */
export function RunStateBadge({
  status,
  stopping = false
}: {
  status: WorkflowRunStatus;
  /** The reader asked to cancel the run and the instance has not ended it yet. */
  stopping?: boolean;
}) {
  const { t } = useTranslation();
  const state = runStatePresentation(status, stopping);
  return state.spins ? (
    <Badge tone={state.tone} size="sm" leading={<Spinner size="sm" />}>
      {t(state.label)}
    </Badge>
  ) : (
    <Badge tone={state.tone} size="sm" dot>
      {t(state.label)}
    </Badge>
  );
}

/** How long something took, or has taken so far while it has not ended. */
export function durationText(
  moments: { startedAt?: string; finishedAt?: string },
  now: Date,
  { locale, t }: Pick<TranslationContextValue, "locale" | "t">
): string | undefined {
  if (moments.startedAt === undefined) {
    return undefined;
  }
  return moments.finishedAt === undefined
    ? t("workflows.run.soFar", { duration: formatElapsed(moments.startedAt, now, locale) })
    : formatElapsed(moments.startedAt, new Date(moments.finishedAt), locale);
}
