import { PanelLeft } from "lucide-react";
import { type SafeConfig } from "@vivd-catalyst/api-client";
import type { CSSProperties, ReactNode } from "react";
import { AgentSelector, type AgentChipDisplay } from "./agent-selector";
import { useTranslation } from "../i18n";
import { type ResolvedThemeMode } from "../theme";
import { Button } from "../ui/button";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "../ui/cn";

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
          <Button type="button" size="sm" disabled={retrying} onClick={onRetry}>
            {t("tryAgain")}
          </Button>
        ) : undefined
      }
    />
  );
}

export function ConfigCheckPanel({
  className,
  error
}: {
  className: string | undefined;
  error: string | undefined;
}) {
  const { t } = useTranslation();
  const failed = error !== undefined;

  return (
    <StatusPanel
      className={className}
      title={failed ? t("couldNotLoadWorkspace") : t("configLoading")}
      description={
        failed ? error || t("workspaceLoadFailedDescription") : t("workspaceLoadingDescription")
      }
    />
  );
}

function StatusPanel({
  className,
  title,
  description,
  action
}: {
  className: string | undefined;
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
      <div className="grid w-full max-w-[380px] gap-2 rounded-lg border bg-card p-5 text-card-foreground shadow-xs">
        <strong className="text-sm font-semibold">{title}</strong>
        <p className="text-sm text-muted-foreground">{description}</p>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
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
          "pointer-events-none absolute inset-x-0 z-40 flex h-16 min-w-0 items-center justify-between gap-3 px-4 transition-[left,right,top] duration-200 lg:right-[var(--display-panel-width)]",
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
