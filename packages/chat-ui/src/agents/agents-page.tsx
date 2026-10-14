import { Bot, Plus } from "lucide-react";
import { useId, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardTarget,
  CardTitle,
  EmptyState,
  InlineError,
  Page,
  PageHeader,
  SkeletonList
} from "@vivd-catalyst/ui";
import { AreaFrame, useAreaTitleFocus } from "../area-frame";
import { agentKind } from "../build-area/agent-kind";
import type { BuildAssetStart } from "../build-area/build-asset-kind";
import { BuildCreateDialog, type BuildCreateStart } from "../build-area/build-create-dialog";
import { useTranslation } from "../i18n";
import { RouteLink } from "../route-link";
import type { WorkspaceRoute } from "../workspace/workspace-route";
import {
  agentStudioRoute,
  agentsStudioRoute,
  type AgentCreation,
  type AgentListStatus,
  type OfferedAgent
} from "./agents-model";

export interface AgentsPageProps {
  /** The agents the person may use in the open workspace, as the agent picker holds them. */
  agents: readonly OfferedAgent[];
  /** The agent a new conversation of the workspace starts with. */
  defaultAgentName: string | undefined;
  status: AgentListStatus;
  onRetry(): void;
  /** Opens a new conversation of the workspace with this agent selected. */
  onStartChat(agentName: string): void;
  /** Present for a person who may open the agents in Studio: the way to a place there. */
  onOpenStudio?(route: WorkspaceRoute): void;
  /**
   * Present for a person who may create an agent. Its dialog opens on this page, and only
   * Continue leads to Studio, where the new agent is written.
   */
  newAgent?: AgentCreation & {
    /** Where the new agent starts available: the open workspace, as one made in Studio does. */
    startsIn: BuildCreateStart;
    onStart(start: BuildAssetStart): void;
  };
}

/**
 * The agents of the open workspace, one card each, and the way into a chat with one. Nothing
 * is changed here: whoever builds agents is led to Studio.
 */
export function AgentsPage({
  agents,
  defaultAgentName,
  status,
  onRetry,
  onStartChat,
  onOpenStudio,
  newAgent
}: AgentsPageProps) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);
  const [creating, setCreating] = useState(false);

  return (
    <AreaFrame ref={areaRef} label={t("agents.title")}>
      <Page>
        <PageHeader
          title={t("agents.title")}
          description={t("agents.description")}
          primaryAction={
            newAgent ? (
              <Button onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" />
                {t("configNewAgent")}
              </Button>
            ) : undefined
          }
        />
        {status === "loading" ? (
          <SkeletonList rows={3} />
        ) : status === "failed" ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("agents.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("tryAgain")}
            </Button>
          </InlineError>
        ) : agents.length === 0 ? (
          <EmptyState
            icon={<Bot aria-hidden="true" />}
            action={
              onOpenStudio ? (
                <RouteLink
                  route={agentsStudioRoute()}
                  variant="primary"
                  size="md"
                  onOpen={onOpenStudio}
                >
                  {t("agents.openStudio")}
                </RouteLink>
              ) : undefined
            }
          >
            {t(onOpenStudio ? "agents.emptyBuilder" : "workspaceNoAgents")}
          </EmptyState>
        ) : (
          <ul aria-label={t("agents.title")} className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
            {agents.map((agent) => (
              <li key={agent.name} className="flex min-w-0">
                <AgentCard
                  agent={agent}
                  isDefault={agent.name === defaultAgentName}
                  onStartChat={onStartChat}
                  onOpenStudio={onOpenStudio}
                />
              </li>
            ))}
          </ul>
        )}
      </Page>
      {newAgent && creating ? (
        <BuildCreateDialog
          entry={agentKind}
          namespaces={newAgent.namespaces}
          mayNameFreely={newAgent.mayNameFreely}
          startsIn={newAgent.startsIn}
          onClose={() => setCreating(false)}
          onStart={(start) => {
            setCreating(false);
            newAgent.onStart(start);
          }}
        />
      ) : null}
    </AreaFrame>
  );
}

/**
 * One agent: its mark, its name, what it does in two lines at most, and the ways into a chat
 * with it. Its starter prompts wait in the empty chat with it, not on the card. The whole card
 * starts the chat.
 */
function AgentCard({
  agent,
  isDefault,
  onStartChat,
  onOpenStudio
}: {
  agent: OfferedAgent;
  isDefault: boolean;
  onStartChat: AgentsPageProps["onStartChat"];
  onOpenStudio: AgentsPageProps["onOpenStudio"];
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const description = agent.description?.trim();

  return (
    <Card padding="md" className="flex w-full min-w-0 flex-col">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar kind="agent" name={agent.displayName} icon={<Bot />} />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle id={titleId} className="min-w-0 break-words">
              {agent.displayName}
            </CardTitle>
            {isDefault ? <Badge size="sm">{t("configDefaultAgent")}</Badge> : null}
          </div>
        </div>
        {description ? (
          <p className="line-clamp-2 text-body text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>
      <CardFooter className="justify-between">
        <CardTarget label={t("agents.startChatWith", { name: agent.displayName })}>
          <Button size="sm" onClick={() => onStartChat(agent.name)}>
            {t("agents.startChat")}
          </Button>
        </CardTarget>
        {onOpenStudio ? (
          <RouteLink
            route={agentStudioRoute(agent.name)}
            variant="link"
            describedBy={titleId}
            onOpen={onOpenStudio}
          >
            {t("agents.editInStudio")}
          </RouteLink>
        ) : null}
      </CardFooter>
    </Card>
  );
}
