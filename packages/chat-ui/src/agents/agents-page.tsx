import { Bot } from "lucide-react";
import { useId } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Chip,
  EmptyState,
  InlineError,
  Page,
  PageHeader,
  SkeletonList
} from "@vivd-catalyst/ui";
import { AreaFrame, useAreaTitleFocus } from "../area-frame";
import { useTranslation } from "../i18n";
import { RouteLink } from "../route-link";
import type { WorkspaceRoute } from "../workspace/workspace-route";
import {
  agentCardPrompts,
  agentStudioRoute,
  agentsStudioRoute,
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
  /**
   * Opens a new conversation of the workspace with this agent selected. With `prompt`, that
   * text stands in the composer.
   */
  onStartChat(agentName: string, prompt?: string): void;
  /** Present for a person who may open the agents in Studio: the way to a place there. */
  onOpenStudio?(route: WorkspaceRoute): void;
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
  onOpenStudio
}: AgentsPageProps) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);

  return (
    <AreaFrame ref={areaRef} label={t("agents.title")}>
      <Page>
        <PageHeader title={t("agents.title")} description={t("agents.description")} />
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
    </AreaFrame>
  );
}

/**
 * One agent: who it is, what it is for, and the ways into a chat with it. The content holds
 * one row per thing the agent says about itself, so a further row joins the suggestions there.
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
  const prompts = agentCardPrompts(agent);
  const description = agent.description?.trim();

  return (
    <Card padding="md" className="flex w-full min-w-0 flex-col">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar kind="agent" name={agent.displayName} />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle id={titleId} className="min-w-0 break-words">
              {agent.displayName}
            </CardTitle>
            {isDefault ? <Badge size="sm">{t("configDefaultAgent")}</Badge> : null}
          </div>
        </div>
        {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
      </CardHeader>
      {prompts.length > 0 ? (
        <CardContent className="grid gap-3">
          <ul aria-label={t("agents.suggestions")} className="flex min-w-0 flex-wrap gap-2">
            {prompts.map((prompt, index) => (
              // An agent may hold the same title twice.
              <li key={index} className="flex min-w-0">
                <Chip onClick={() => onStartChat(agent.name, prompt.prompt)}>{prompt.title}</Chip>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
      <CardFooter className="justify-between">
        <Button size="sm" aria-describedby={titleId} onClick={() => onStartChat(agent.name)}>
          {t("agents.startChat")}
        </Button>
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
