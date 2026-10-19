import { useState } from "react";
import type { AgentAvailability } from "@work-shape/catalyst-api-client";
import { ConfirmDialog } from "@work-shape/catalyst-ui";
import type { AvailableIn, DependencyConsent } from "../../shared/api/asset-writes";
import { useTranslation } from "../../shared/i18n";
import { MissingDependencies, type DependencyAvailability } from "./dependency-availability";

/**
 * What a new agent's page asks before the create: what the agent would use that members could
 * not use where it starts. The instance reads it for the definition and the availability
 * without writing anything.
 */
export interface AgentCreateCheck {
  /** Where the agent starts, as the create dialog chose it. */
  availability: AgentAvailability;
  /** The name of the workspace it starts in, by its id. */
  workspaceName(id: string): string | undefined;
  read(config: Record<string, unknown>): Promise<DependencyAvailability | null>;
}

/**
 * Where a new agent starts, as an availability: the workspace it is made in, everywhere, or
 * hidden where the create dialog chose nothing.
 */
export function startAvailability(availableIn: AvailableIn | undefined): AgentAvailability {
  if (availableIn === "all") {
    return { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] };
  }
  return {
    mode: "selected",
    personalWorkspaces: false,
    collaborationWorkspaceIds: availableIn === undefined ? [] : [availableIn.workspaceId]
  };
}

/**
 * The create of an agent whose Knowledge Bases or Connections are missing where it starts: the
 * offer a publish and an availability save make, before anything is written. The choice starts
 * unticked; Create writes the agent with it, Cancel writes nothing.
 */
export function AgentCreateReview({
  name,
  check,
  dependencies,
  onCreate,
  onClose
}: {
  /** The agent's name as the form holds it. */
  name: string;
  check: AgentCreateCheck;
  dependencies: DependencyAvailability;
  /** Creates the agent: with the reader's choice, for the availability the dialog named. */
  onCreate(dependencyConsent: DependencyConsent | undefined): Promise<unknown>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [makeAvailable, setMakeAvailable] = useState(false);
  const [creating, setCreating] = useState(false);
  // Where the instance read the list for, which may be wider than asked: the instance's first
  // agent becomes its default, available everywhere. The choice holds for that availability.
  const reviewed = dependencies.availability ?? check.availability;
  return (
    <ConfirmDialog
      open
      tone="primary"
      title={t("configCreateAgentReviewTitle", { name })}
      confirmLabel={t("configCreateAgent")}
      loading={creating}
      onConfirm={() => {
        setCreating(true);
        onCreate(makeAvailable ? { expectedAvailability: reviewed } : undefined)
          .catch(() => undefined)
          .finally(onClose);
      }}
      onClose={onClose}
    >
      <MissingDependencies
        dependencies={dependencies}
        availability={reviewed}
        workspaceName={check.workspaceName}
        makeAvailable={makeAvailable}
        disabled={creating}
        onMakeAvailableChange={setMakeAvailable}
      />
    </ConfirmDialog>
  );
}
