import { Workflow } from "lucide-react";
import { EmptyState, List, ListRow } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { workspaceRoutePath } from "../../shared/routes";
import { useWorkflowsHost } from "../workflows/workflows-host";
import type { DataFlowRef, DataFlowRole, DataFlows } from "./data-flows-model";
import { usingPageRoute } from "./data-store-source";

// The list of the data Workflows of one role on a Knowledge Base's or a store's page.

/** The page of a Workflow by its name, or nothing where the reader is shown no such page. */
export type DataFlowPage = (name: string) => { href: string; open(): void } | undefined;

/**
 * The page of a Workflow inside the workspace the reader has open, where the Workflows area is
 * open to the reader. The Knowledge Base page reaches Workflows this way; a store's page asks
 * its source, which also knows the store's own workspace.
 */
export function useWorkflowPage(): DataFlowPage {
  const workflows = useWorkflowsHost();
  return (name) => {
    const route = usingPageRoute("workflow", name, {
      collaborationWorkspaceId: workflows?.workspace?.id,
      apps: false,
      workflows: workflows !== undefined
    });
    return route && workflows
      ? { href: workspaceRoutePath(route), open: () => workflows.showRoute(route) }
      : undefined;
  };
}

/**
 * The data Workflows of one role, each a link to its page, with how many more the reader may
 * not see. The section around it says what they do, so a row carries no chip of its own.
 */
export function DataFlowList({
  flows,
  role,
  pageOf,
  label,
  showTruncated = true
}: {
  flows: DataFlows;
  role: DataFlowRole;
  pageOf: DataFlowPage;
  /** Names the list for assistive technology: the section's title. */
  label: string;
  /** Says that the list may be incomplete, where the instance cut its read. */
  showTruncated?: boolean;
}) {
  const { locale, t } = useTranslation();
  const rows = flows[role];
  const hiddenCount = flows.hidden[role];
  const count = new Intl.NumberFormat(locale).format(hiddenCount);
  return (
    <>
      {rows.length > 0 ? (
        <List aria-label={label}>
          {rows.map((flow) => (
            <DataFlowRow key={flow.id} flow={flow} role={role} page={pageOf(flow.name)} />
          ))}
        </List>
      ) : null}
      {hiddenCount === 0 ? null : rows.length > 0 ? (
        <p className="text-caption text-muted-foreground" data-data-flows-hidden={role}>
          {t("workflows.flows.hidden", { count })}
        </p>
      ) : (
        <EmptyState layout="inline" data-data-flows-hidden={role}>
          {hiddenCount === 1
            ? t("workflows.flows.hiddenOnlyOne")
            : t("workflows.flows.hiddenOnly", { count })}
        </EmptyState>
      )}
      {showTruncated && flows.truncated ? (
        <p className="text-caption text-muted-foreground">{t("workflows.flows.truncated")}</p>
      ) : null}
    </>
  );
}

function DataFlowRow({
  flow,
  role,
  page
}: {
  flow: DataFlowRef;
  role: DataFlowRole;
  page: ReturnType<DataFlowPage>;
}) {
  return (
    <ListRow
      data-data-flow={role}
      leading={<Workflow aria-hidden="true" className="size-4 text-muted-foreground" />}
      title={flow.title.trim() || flow.name}
      link={
        page === undefined ? undefined : (
          <a
            href={page.href}
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
                page.open();
              }
            }}
          />
        )
      }
    />
  );
}
