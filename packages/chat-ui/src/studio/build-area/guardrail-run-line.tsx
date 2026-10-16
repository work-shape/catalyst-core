import type { ReactNode } from "react";
import type { SettingsPageContextValue } from "../../shared/settings-page-context";
import { useAdministeredCollaborationWorkspacesQuery } from "../../shared/api/workspace-queries";
import { useTranslation } from "../../shared/i18n";
import { useInboxItemKindLookup } from "../../chat/inbox/inbox-item-kinds";
import { useOptionalSettingsPage } from "../../shared/settings-page-context";
import { guardrailRunSentence, type GuardrailRunFacts } from "./guardrail-sentence";

// The line that says when a guardrail runs, on the Guardrails list and on a guardrail's page,
// with the names of the workspaces the reader may know.

/** A workspace's name by its id, where the reader may know it. */
export type WorkspaceNameOf = (id: string) => string | undefined;

const unnamed: WorkspaceNameOf = () => undefined;

/**
 * Hands its children the names of the workspaces: those an administrator reads on the instance,
 * and the one the person works in. Outside the settings pages, as in a page rendered alone, it
 * knows none, and a workspace reads as "one workspace".
 */
export function WorkspaceNames({ children }: { children(nameOf: WorkspaceNameOf): ReactNode }) {
  const settings = useOptionalSettingsPage();
  return settings ? (
    <AdministeredWorkspaceNames settings={settings}>{children}</AdministeredWorkspaceNames>
  ) : (
    children(unnamed)
  );
}

function AdministeredWorkspaceNames({
  settings,
  children
}: {
  settings: SettingsPageContextValue;
  children(nameOf: WorkspaceNameOf): ReactNode;
}) {
  const { apiBaseUrl, authScope, client, activeWorkspace } = settings;
  const query = useAdministeredCollaborationWorkspacesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });
  const names = new Map((query.data ?? []).map((workspace) => [workspace.id, workspace.name]));
  if (activeWorkspace) names.set(activeWorkspace.id, activeWorkspace.name);
  return children((id) => names.get(id));
}

/** When a guardrail runs and what it does, in the reader's language. */
export function useGuardrailRunSentence(): (
  facts: GuardrailRunFacts,
  workspaceName: WorkspaceNameOf
) => string {
  const { t } = useTranslation();
  const lookup = useInboxItemKindLookup();
  return (facts, workspaceName) =>
    guardrailRunSentence(facts, {
      t,
      workspaceName,
      requestKind: (kind) => {
        const known = lookup(kind);
        return known ? t(known.label) : undefined;
      }
    });
}

/** The line of one guardrail, with the workspace names it finds. */
export function GuardrailRunLine({ facts }: { facts: GuardrailRunFacts }) {
  const sentence = useGuardrailRunSentence();
  return (
    <WorkspaceNames>
      {(nameOf) => <span data-guardrail-runs="">{sentence(facts, nameOf)}</span>}
    </WorkspaceNames>
  );
}
