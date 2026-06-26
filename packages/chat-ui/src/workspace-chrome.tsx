import { PanelLeft } from "lucide-react";
import { type SafeConfig } from "@vivd-catalyst/api-client";
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
    <main
      className={cn(
        "grid h-dvh w-full place-items-center overflow-hidden bg-sidebar p-5 text-foreground",
        className
      )}
    >
      <div className="grid w-full max-w-[380px] gap-2 rounded-lg border bg-card p-5 text-card-foreground shadow-xs">
        <strong className="text-sm font-semibold">
          {error ? t("couldNotVerifySession") : t("checkingSession")}
        </strong>
        <p className="text-sm text-muted-foreground">{error ?? t("sessionCheckingDescription")}</p>
      </div>
    </main>
  );
}

export function WorkspaceChrome({
  agents,
  displayPanelOpen,
  sidebarOpen,
  selectedAgentName,
  themeMode,
  onSelectAgent,
  onToggleSidebar,
  onToggleTheme
}: {
  agents: SafeConfig["agents"];
  displayPanelOpen: boolean;
  sidebarOpen: boolean;
  selectedAgentName: string | undefined;
  themeMode: ResolvedThemeMode;
  onSelectAgent: (agentName: string) => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute left-4 top-3 z-50 flex min-w-0 items-center gap-2 transition-[left] duration-200",
          sidebarOpen && "max-md:hidden md:left-[19rem]"
        )}
      >
        {!sidebarOpen ? (
          <button
            type="button"
            className={cn(
              "pointer-events-auto inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors outline-none",
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
          <div className="pointer-events-auto min-w-0">
            <AgentSelector
              agents={agents}
              selectedAgentName={selectedAgentName}
              onSelectAgent={onSelectAgent}
            />
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "pointer-events-none absolute right-4 top-3 z-50 flex items-center gap-2",
          displayPanelOpen && "lg:hidden"
        )}
      >
        <div className="pointer-events-auto">
          <ThemeToggle mode={themeMode} onToggle={onToggleTheme} />
        </div>
      </div>
    </>
  );
}
