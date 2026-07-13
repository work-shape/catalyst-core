import { PanelLeft } from "lucide-react";
import { type SafeConfig } from "@vivd-catalyst/api-client";
import type { CSSProperties } from "react";
import { AgentSelector } from "./agent-selector";
import { useTranslation } from "./i18n";
import { type ResolvedThemeMode } from "./theme";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "./ui/cn";

export function SessionCheckPanel({
  className,
  error
}: {
  className: string | undefined;
  error: string | undefined;
}) {
  const { t } = useTranslation();

  return (
    <StatusPanel
      className={className}
      title={error ? t("couldNotVerifySession") : t("checkingSession")}
      description={error ?? t("sessionCheckingDescription")}
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
  description
}: {
  className: string | undefined;
  title: string;
  description: string;
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
      </div>
    </main>
  );
}

export function WorkspaceChrome({
  agents,
  contextLabel,
  displayPanelOpen,
  displayPanelWidth,
  environment,
  sidebarOpen,
  selectedAgentName,
  themeMode,
  onSelectAgent,
  onToggleSidebar,
  onToggleTheme
}: {
  agents: SafeConfig["agents"];
  contextLabel?: string;
  displayPanelOpen: boolean;
  displayPanelWidth: number;
  environment: SafeConfig["clientInstance"]["environment"] | undefined;
  sidebarOpen: boolean;
  selectedAgentName: string | undefined;
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
          "pointer-events-auto absolute inset-x-0 z-40 flex h-16 min-w-0 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur transition-[left,right,top] duration-200 lg:right-[var(--display-panel-width)]",
          isStaging ? "top-6" : "top-0",
          sidebarOpen && "max-md:hidden md:left-80"
        )}
        style={
          {
            "--display-panel-width": displayPanelOpen ? `${displayPanelWidth}px` : "0px"
          } as CSSProperties
        }
      >
        <div className="flex min-w-0 items-center gap-2">
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
          {agents.length > 0 ? (
            <AgentSelector
              agents={agents}
              contextLabel={contextLabel}
              selectedAgentName={selectedAgentName}
              onSelectAgent={onSelectAgent}
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle mode={themeMode} onToggle={onToggleTheme} />
        </div>
      </header>
    </>
  );
}
