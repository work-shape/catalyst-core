import { PanelLeft } from "lucide-react";
import { type SafeConfig } from "@work-shape/catalyst-api-client";
import type { ReactNode } from "react";
import {
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  IconButton
} from "@work-shape/catalyst-ui";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { AgentSelector, type AgentChipDisplay } from "./agent-selector";
import { useTranslation } from "../../shared/i18n";

/**
 * Shown once when the server no longer knows an operation this interface calls, or answers one
 * outside the schema this interface was built with, which happens to a tab that stayed open
 * across an upgrade. The reader reloads; nothing reloads by itself.
 */
export function OutdatedInterfaceNotice() {
  const { interfaceOutdated } = useWorkspaceApiClient();
  return interfaceOutdated ? (
    <OutdatedInterfaceBanner onReload={() => window.location.reload()} />
  ) : null;
}

export function OutdatedInterfaceBanner({ onReload }: { onReload(): void }) {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-3">
      {/*
       * The banner's fill is a tint, so it floats on the raised surface: the page under it does
       * not show through.
       */}
      <div className="pointer-events-auto w-full max-w-xl rounded-md bg-popover shadow-lg">
        <Banner
          tone="warning"
          title={t("interfaceOutdatedTitle")}
          action={
            <Button size="sm" variant="secondary" onClick={onReload}>
              {t("interfaceOutdatedReload")}
            </Button>
          }
        >
          {t("interfaceOutdatedBody")}
        </Banner>
      </div>
    </div>
  );
}

export function SessionCheckPanel({
  className,
  unavailable,
  disabled = false,
  retrying,
  signingOut = false,
  onRetry,
  onSignOut
}: {
  className: string | undefined;
  unavailable: boolean;
  /** The account is disabled: only an administrator helps, and the person may sign out. */
  disabled?: boolean;
  retrying: boolean;
  signingOut?: boolean;
  onRetry(): void;
  onSignOut?(): void;
}) {
  const { t } = useTranslation();

  if (disabled) {
    return (
      <StatusPanel
        className={className}
        role="alert"
        title={t("accountDisabledTitle")}
        description={t("accountDisabledDescription")}
        action={
          onSignOut ? (
            <Button size="sm" variant="secondary" disabled={signingOut} onClick={onSignOut}>
              {t("signOut")}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <StatusPanel
      className={className}
      title={unavailable ? t("sessionUnavailableTitle") : t("checkingSession")}
      description={
        unavailable ? t("sessionUnavailableDescription") : t("sessionCheckingDescription")
      }
      action={
        unavailable ? (
          <Button size="sm" disabled={retrying} onClick={onRetry}>
            {t("tryAgain")}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * What stands in for the workspace until the instance configuration has loaded. A failed load
 * offers both ways out. An answer from another release reads as the outdated-tab notice does,
 * because that is what it is.
 */
export function ConfigCheckPanel({
  className,
  failure,
  retrying,
  onRetry,
  onReload
}: {
  className: string | undefined;
  failure: "outdated" | "unavailable" | undefined;
  retrying: boolean;
  onRetry(): void;
  onReload(): void;
}) {
  const { t } = useTranslation();

  if (failure === undefined) {
    return (
      <StatusPanel
        className={className}
        title={t("configLoading")}
        description={t("workspaceLoadingDescription")}
      />
    );
  }

  const outdated = failure === "outdated";
  return (
    <StatusPanel
      className={className}
      role="alert"
      title={outdated ? t("interfaceOutdatedTitle") : t("couldNotLoadWorkspace")}
      description={outdated ? t("interfaceOutdatedBody") : t("workspaceLoadFailedDescription")}
      action={
        <>
          <Button
            size="sm"
            variant={outdated ? "secondary" : "primary"}
            disabled={retrying}
            onClick={onRetry}
          >
            {t("tryAgain")}
          </Button>
          <Button size="sm" variant={outdated ? "primary" : "secondary"} onClick={onReload}>
            {t("interfaceOutdatedReload")}
          </Button>
        </>
      }
    />
  );
}

function StatusPanel({
  className,
  role,
  title,
  description,
  action
}: {
  className: string | undefined;
  role?: "alert";
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <main
      className={cn(
        "grid h-dvh w-full place-items-center overflow-hidden bg-sidebar p-5 text-foreground",
        className
      )}
    >
      <Card padding="md" role={role} className="w-full max-w-[380px] shadow-xs">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className="text-body text-muted-foreground">{description}</p>
        </CardHeader>
        {action ? <CardContent className="flex flex-wrap gap-2">{action}</CardContent> : null}
      </Card>
    </main>
  );
}

/**
 * Says why a link did not open: it led into a workspace the person is no member of, and the page
 * went to their own workspace instead. It names the workspace's owners and admins to ask, where
 * the instance named any.
 */
export function ClosedWorkspaceLinkBanner({
  administrators,
  onDismiss
}: {
  administrators: readonly string[];
  onDismiss(): void;
}) {
  const { locale, t } = useTranslation();
  const names = new Intl.ListFormat(locale, { type: "disjunction" }).format(administrators);
  return (
    <Banner tone="info" layout="page" className="shrink-0" onDismiss={onDismiss}>
      {administrators.length > 0
        ? t("collaborationWorkspaceLinkClosedAsk", { names })
        : t("collaborationWorkspaceLinkClosed")}
    </Banner>
  );
}

/** Says on every page that this instance is the test environment. Other environments show nothing. */
export function StagingBanner({ environment }: { environment: string }) {
  const { t } = useTranslation();
  if (environment !== "staging") {
    return null;
  }
  return (
    <Banner tone="warning" layout="page" icon={null} className="shrink-0 justify-center">
      {t("testEnvironment")}
    </Banner>
  );
}

/**
 * The header of the chat: the button that opens the rail's drawer under 768 px and the agent
 * selector. It is a solid band, which ends where a surface beside it begins, so nothing that
 * scrolls passes under the controls. Outside a conversation it gives way to a pinned detail head,
 * which is a band of its own: the controls float over its start.
 *
 * Its fade reaches 1rem below the band. At rest nothing stands under the band or the fade: a
 * thread starts 5rem down, and a page starts below the band in a narrow window. Only what has
 * scrolled up passes under them.
 */
export function WorkspaceChrome({
  agentDisplay,
  agents,
  conversation,
  surfaceBesideWidth,
  covered,
  selectedAgentName,
  showAgentSelector,
  onSelectAgent,
  onOpenSidebar
}: {
  agentDisplay: AgentChipDisplay;
  agents: SafeConfig["agents"];
  /**
   * True on a conversation: the band stands whatever a surface beside it shows. Elsewhere it
   * gives way where the main area holds a pinned detail head.
   */
  conversation: boolean;
  /** What a surface takes of the main area beside the conversation, in pixels. */
  surfaceBesideWidth: number;
  /** A surface covers the main area, so the header leaves the tab order with the chat. */
  covered: boolean;
  selectedAgentName: string | undefined;
  /** False while the start page shows the agent above its heading. */
  showAgentSelector: boolean;
  onSelectAgent: (agentName: string) => void;
  onOpenSidebar: () => void;
}) {
  const { t } = useTranslation();
  const besideSurface = surfaceBesideWidth > 0;

  return (
    <header
      data-beside-surface={besideSurface ? "" : undefined}
      className={cn(
        "pointer-events-none absolute top-0 left-0 z-40 flex h-(--layout-header) min-w-0 items-center gap-2 bg-background px-4 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-gradient-to-b after:from-background after:to-transparent after:content-['']",
        // Outside a conversation the header holds only the button that opens the drawer, so
        // from 768 px up it holds nothing and is gone: a page's title line there is 56 px down,
        // where the band and its fade would cover it.
        !conversation && "md:hidden",
        // A pinned detail head, and a sub-rail whose area name stands beside that button, are
        // bands of their own.
        !conversation &&
          "group-has-[[data-page-head][data-variant=detail]]/workspace-content:bg-transparent group-has-[[data-page-head][data-variant=detail]]/workspace-content:after:hidden",
        !conversation &&
          "group-has-[[data-subrail-title]]/workspace-content:bg-transparent group-has-[[data-subrail-title]]/workspace-content:after:hidden",
        // Beside a surface the header is a band like the surface's own: one line runs across
        // the window, and the thread scrolls under the band, not under the controls.
        // The fade starts below the border so it cannot paint over that line.
        besideSurface && "border-b after:translate-y-px"
      )}
      style={{ right: surfaceBesideWidth }}
      inert={covered}
    >
      <div className="pointer-events-auto flex min-w-0 items-center gap-2">
        <IconButton className="md:hidden" label={t("openSidebar")} onClick={onOpenSidebar}>
          <PanelLeft aria-hidden="true" />
        </IconButton>
        {showAgentSelector && agents.length > 0 ? (
          <AgentSelector
            agents={agents}
            display={agentDisplay}
            placement="header"
            selectedAgentName={selectedAgentName}
            onSelectAgent={onSelectAgent}
          />
        ) : null}
      </div>
    </header>
  );
}
