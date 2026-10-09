import { PanelLeft } from "lucide-react";
import { type SafeConfig } from "@vivd-catalyst/api-client";
import type { CSSProperties, ReactNode } from "react";
import { Banner, Button, Card, CardContent, CardHeader, CardTitle, cn } from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { AgentSelector, type AgentChipDisplay } from "./agent-selector";
import { useTranslation } from "../i18n";
import { type ResolvedThemeMode } from "../theme";
import { ThemeToggle } from "./theme-toggle";

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
      <Banner
        tone="warning"
        title={t("interfaceOutdatedTitle")}
        action={
          <Button size="sm" variant="secondary" onClick={onReload}>
            {t("interfaceOutdatedReload")}
          </Button>
        }
        className="pointer-events-auto w-full max-w-xl shadow-lg"
      >
        {t("interfaceOutdatedBody")}
      </Banner>
    </div>
  );
}

export function SessionCheckPanel({
  className,
  unavailable,
  retrying,
  onRetry
}: {
  className: string | undefined;
  unavailable: boolean;
  retrying: boolean;
  onRetry(): void;
}) {
  const { t } = useTranslation();

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

export function WorkspaceChrome({
  agentDisplay,
  agents,
  displayPanelOpen,
  displayPanelWidth,
  environment,
  sidebarOpen,
  selectedAgentName,
  showAgentSelector,
  themeMode,
  onSelectAgent,
  onToggleSidebar,
  onToggleTheme
}: {
  agentDisplay: AgentChipDisplay;
  agents: SafeConfig["agents"];
  displayPanelOpen: boolean;
  displayPanelWidth: number;
  environment: SafeConfig["clientInstance"]["environment"] | undefined;
  sidebarOpen: boolean;
  selectedAgentName: string | undefined;
  /** False while the start page shows the agent above its heading. */
  showAgentSelector: boolean;
  themeMode: ResolvedThemeMode;
  onSelectAgent: (agentName: string) => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
}) {
  const { t } = useTranslation();
  const isStaging = environment === "staging";

  return (
    <>
      {isStaging ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-[60] grid h-6 place-items-center border-b border-amber-600/35 bg-amber-400 text-[11px] font-semibold tracking-[0.08em] text-amber-950"
          role="status"
        >
          {t("testEnvironment")}
        </div>
      ) : null}

      <header
        className={cn(
          "pointer-events-none absolute inset-x-0 z-40 flex h-16 min-w-0 items-center justify-between gap-3 px-4 transition-[left,top] duration-200 right-[var(--display-panel-width)]",
          isStaging ? "top-6" : "top-0",
          sidebarOpen && "max-md:hidden md:left-80"
        )}
        style={
          {
            "--display-panel-width": displayPanelOpen ? `${displayPanelWidth}px` : "0px"
          } as CSSProperties
        }
      >
        {/* The chat scrolls all the way to the top, so the controls float over
            it; this fade keeps them legible once messages pass underneath. */}
        <div
          className="pointer-events-none absolute inset-x-0 -top-px bottom-0 -z-10 bg-gradient-to-b from-background/25 via-background/3 to-transparent"
          aria-hidden="true"
        />

        <div className="pointer-events-auto flex min-w-0 items-center gap-2">
          {!sidebarOpen ? (
            <button
              type="button"
              className={cn(
                "inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none",
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
              )}
              aria-label={t("openSidebar")}
              title={t("openSidebar")}
              aria-pressed="false"
              onClick={onToggleSidebar}
            >
              <PanelLeft size={17} aria-hidden="true" />
            </button>
          ) : null}
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
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
          <ThemeToggle mode={themeMode} onToggle={onToggleTheme} />
        </div>
      </header>
    </>
  );
}
