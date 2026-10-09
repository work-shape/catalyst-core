import { PanelLeft } from "lucide-react";
import { type SafeConfig } from "@vivd-catalyst/api-client";
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
} from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { AgentSelector, type AgentChipDisplay } from "./agent-selector";
import { useTranslation } from "../i18n";

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
 * selector. It floats over the conversation and ends where a surface beside it begins.
 */
export function WorkspaceChrome({
  agentDisplay,
  agents,
  surfaceBesideWidth,
  covered,
  selectedAgentName,
  showAgentSelector,
  onSelectAgent,
  onOpenSidebar
}: {
  agentDisplay: AgentChipDisplay;
  agents: SafeConfig["agents"];
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

  return (
    <header
      className="pointer-events-none absolute top-0 left-0 z-40 flex h-(--layout-header) min-w-0 items-center gap-2 px-4"
      style={{ right: surfaceBesideWidth }}
      inert={covered}
    >
      {/* The chat scrolls all the way to the top, so the controls float over
          it; this fade keeps them legible once messages pass underneath. */}
      <div
        className="pointer-events-none absolute inset-x-0 -top-px bottom-0 -z-10 bg-gradient-to-b from-background/25 via-background/3 to-transparent"
        aria-hidden="true"
      />
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
