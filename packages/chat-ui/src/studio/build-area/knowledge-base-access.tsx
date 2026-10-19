import { Bot, KeyRound } from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Chip,
  EmptyState,
  InlineError,
  List,
  ListRow,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { principalHref } from "../../admin/access/principal-grants-model";
import { AGENTS_BUILD_PATH, useBuildNavigation } from "../../shared/build-route";
import { useTranslation } from "../../shared/i18n";
import { workspaceRoutePath } from "../../shared/routes";
import type { KnowledgeHoldersRead } from "./knowledge-base-source";

/** Where a service principal is read: its row under Settings, API access. */
function servicePrincipalHref(principalId: string): string {
  return principalHref(
    workspaceRoutePath({ kind: "settings", group: "instance", page: "api-access" }),
    principalId
  );
}

/**
 * Who was given `knowledge_base.use` on this Knowledge Base itself: each person by name and
 * address, each service principal by name with a link to it. Workspace members search it
 * through "Available in" and are not listed.
 */
export function KnowledgeBaseHolders({
  read
}: {
  read: Exclude<KnowledgeHoldersRead, { status: "hidden" }>;
}) {
  const { t } = useTranslation();
  if (read.status === "loading") {
    return <SkeletonList rows={2} />;
  }
  if (read.status === "failed") {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{t("knowledge.accessFailed")}</span>
        <Button variant="outline" size="sm" onClick={read.retry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }
  if (read.holders.length === 0) {
    return <EmptyState layout="inline">{t("knowledge.accessEmpty")}</EmptyState>;
  }
  return (
    <List aria-label={t("knowledge.accessTitle")}>
      {read.holders.map((holder) => {
        if (holder.kind === "person") {
          const name = holder.name ?? t("knowledge.accessUnknownPerson");
          return (
            <ListRow
              key={holder.grantId}
              data-holder-kind="person"
              leading={<Avatar kind="person" size="sm" name={name} />}
              title={name}
              description={holder.detail}
            />
          );
        }
        const name = holder.name ?? t("knowledge.accessUnknownPrincipal");
        return (
          <ListRow
            key={holder.grantId}
            data-holder-kind="service_principal"
            leading={
              <Avatar kind="service" size="sm" name={name} icon={<KeyRound aria-hidden="true" />} />
            }
            title={name}
            chips={
              <>
                <Chip size="sm">{t("knowledge.accessServicePrincipal")}</Chip>
                {holder.disabled ? (
                  <Badge tone="neutral" size="sm">
                    {t("knowledge.accessPrincipalDisabled")}
                  </Badge>
                ) : null}
              </>
            }
            link={
              holder.name === undefined ? undefined : <a href={servicePrincipalHref(holder.id)} />
            }
          />
        );
      })}
    </List>
  );
}

/**
 * The published agents that search this Knowledge Base, as far as the reader may read them,
 * each a link to its page. Where the instance read only part of its agents, it says so.
 */
export function KnowledgeBaseAgents({
  agents,
  truncated
}: {
  agents: readonly { name: string; title: string }[];
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const { href, open } = useBuildNavigation();
  return (
    <>
      {agents.length === 0 ? (
        <EmptyState layout="inline">{t("knowledge.agentsEmpty")}</EmptyState>
      ) : (
        <List aria-label={t("knowledge.agentsTitle")}>
          {agents.map((agent) => {
            const place = { kindPath: AGENTS_BUILD_PATH, name: agent.name };
            return (
              <ListRow
                key={agent.name}
                data-knowledge-agent={agent.name}
                leading={<Bot aria-hidden="true" className="size-4 text-muted-foreground" />}
                title={agent.title.trim() || agent.name}
                link={
                  <a
                    href={href(place)}
                    onClick={(event) => {
                      // A plain press opens the page here. Any other opens the address.
                      if (
                        event.button === 0 &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey &&
                        !event.altKey
                      ) {
                        event.preventDefault();
                        open(place);
                      }
                    }}
                  />
                }
              />
            );
          })}
        </List>
      )}
      {truncated ? (
        <p className="text-caption text-muted-foreground" data-knowledge-agents-truncated="">
          {t("knowledge.agentsTruncated")}
        </p>
      ) : null}
    </>
  );
}
