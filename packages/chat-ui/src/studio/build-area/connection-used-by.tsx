import { BookOpen, Bot, LayoutGrid, Workflow } from "lucide-react";
import type { MouseEvent } from "react";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import type { PublishedDataConsumerKind } from "@work-shape/catalyst-core";
import { Chip, EmptyState, List, ListRow } from "@work-shape/catalyst-ui";
import { useBuildNavigation } from "../../shared/build-route";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { agentKind } from "./agent-kind";
import { useUsingPage } from "./data-store-source";
import { knowledgeBaseKind } from "./knowledge-base-kind";

// "Used by" on a Connection's page: the agents that carry one of its tools, and the published
// Apps, Workflows and Knowledge Bases that use it, each the reader may read. A row names what
// uses the Connection by its title and kind and opens its page; no row shows an id. An App or
// Workflow of a workspace opens in that workspace; a Knowledge Base of a workspace has no page
// in Build's instance scope, so its row is a plain line.

type UsingAsset = NonNullable<ConnectionDetail["usedByAssets"]>[number];

const KINDS: Record<PublishedDataConsumerKind, { icon: typeof Workflow; label: TranslationKey }> = {
  app: { icon: LayoutGrid, label: "connectionPage.kindApp" },
  workflow: { icon: Workflow, label: "connectionPage.kindWorkflow" },
  knowledge_base: { icon: BookOpen, label: "connectionPage.kindKnowledgeBase" }
};

/** How many rows "Used by" counts: the agents and the other assets. */
export function usedByCount(detail: ConnectionDetail): number {
  return detail.usedBy.length + (detail.usedByAssets?.length ?? 0);
}

/** The names "Used by" lists: the agents by title, the other assets by title and kind. */
export function usedByNames(
  detail: Pick<ConnectionDetail, "usedBy" | "usedByAssets">,
  t: (key: TranslationKey) => string
): string[] {
  return [
    ...detail.usedBy.map((agent) => agent.title.trim() || agent.agentName),
    ...(detail.usedByAssets ?? []).map(
      (asset) => `${asset.title.trim() || asset.name} (${t(KINDS[asset.kind].label)})`
    )
  ];
}

/**
 * The link of a row, which opens its page here on a plain press and its address on any other.
 * The row puts its content into this element, so it is an `a` itself.
 */
function pageLink({ href, open }: { href: string; open(): void }) {
  return (
    <a
      href={href}
      onClick={(event: MouseEvent) => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          open();
        }
      }}
    />
  );
}

export function ConnectionUsedBy({ detail }: { detail: ConnectionDetail }) {
  const { t } = useTranslation();
  const { href, open } = useBuildNavigation();
  const pageOf = useUsingPage(undefined);
  /** The page of one asset, in the scope that owns it, or nothing where Build has none. */
  const pageOfAsset = (asset: UsingAsset) => {
    if (asset.kind !== "knowledge_base") return pageOf(asset.kind, asset.name, asset.workspaceId);
    if (asset.workspaceId !== undefined) return undefined;
    const place = { kindPath: knowledgeBaseKind.path, name: asset.name };
    return { href: href(place), open: () => open(place) };
  };
  const assets = detail.usedByAssets ?? [];
  const truncated = detail.usedByAssetsTruncated === true;
  if (detail.usedBy.length === 0 && assets.length === 0) {
    // The scan stopped at its bound: nothing listed is no proof that nothing uses it.
    if (truncated) {
      return (
        <p className="text-body text-muted-foreground" data-connection-used-by-truncated="">
          {t("connectionPage.usedByNoneShown")}
        </p>
      );
    }
    // An instance that names no other assets has told only of agents.
    return (
      <EmptyState layout="inline">
        {t(
          detail.usedByAssets === undefined
            ? "connections.agentsEmpty"
            : "connectionPage.usedByEmpty"
        )}
      </EmptyState>
    );
  }
  return (
    <div className="grid min-w-0 gap-2">
      <List aria-label={t("connections.agentsTitle")}>
        {detail.usedBy.map((agent) => {
          const place = { kindPath: agentKind.path, name: agent.agentName };
          return (
            <ListRow
              key={`agent:${agent.agentName}`}
              data-connection-used-by="agent"
              leading={<Bot aria-hidden="true" className="size-4 text-muted-foreground" />}
              title={agent.title.trim() || agent.agentName}
              chips={<Chip size="sm">{t("connectionPage.kindAgent")}</Chip>}
              time={t(
                agent.toolNames.length === 1 ? "connections.agentTool" : "connections.agentTools",
                { count: agent.toolNames.length }
              )}
              link={pageLink({ href: href(place), open: () => open(place) })}
            />
          );
        })}
        {assets.map((asset) => {
          const { icon: Icon, label } = KINDS[asset.kind];
          const page = pageOfAsset(asset);
          return (
            <ListRow
              key={`${asset.kind}:${asset.workspaceId ?? ""}:${asset.name}`}
              data-connection-used-by={asset.kind}
              leading={<Icon aria-hidden="true" className="size-4 text-muted-foreground" />}
              title={asset.title.trim() || asset.name}
              chips={<Chip size="sm">{t(label)}</Chip>}
              link={page === undefined ? undefined : pageLink(page)}
            />
          );
        })}
      </List>
      {truncated ? (
        <p className="text-caption text-muted-foreground" data-connection-used-by-truncated="">
          {t("connectionPage.usedByTruncated")}
        </p>
      ) : null}
    </div>
  );
}
