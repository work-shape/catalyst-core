import type { ReactNode } from "react";
import { EmptyState, RegistryIcon } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { BuildWithAgentEmptyState } from "../build-with-agent-empty";
import { isEditableKind } from "./build-asset-kind";
import type { VisibleBuildKind } from "./build-model";

/**
 * The kinds without a page to write one by hand that an agent's first save creates, with the
 * words of their New button and the sentence it starts the agent with.
 */
export const BUILT_WITH_AGENT: Readonly<
  Record<string, { label: TranslationKey; prompt: TranslationKey } | undefined>
> = {
  data_store: { label: "dataStores.new", prompt: "dataStores.newPrompt" }
};

/**
 * A kind's list while it holds nothing. A kind that offers the agent on it does so to whoever
 * the New button opens the agent for; every other kind offers its New button as it is.
 */
export function BuildListEmpty({
  kind: { entry, state },
  newButton,
  startWithAgent
}: {
  kind: VisibleBuildKind;
  newButton: ReactNode;
  /** What the kind's New does where it opens the agent. */
  startWithAgent: ((prompt: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const icon = <RegistryIcon name={entry.icon} />;
  if (entry.emptyBuild) {
    return (
      <BuildWithAgentEmptyState
        icon={icon}
        readerText={entry.emptyText}
        copy={entry.emptyBuild}
        {...(startWithAgent ? { onBuild: startWithAgent } : {})}
      />
    );
  }
  const readOnly = isEditableKind(entry) && !state.canCreate;
  return (
    <EmptyState icon={icon} action={newButton}>
      {t(readOnly ? entry.emptyReadOnlyText : entry.emptyText)}
    </EmptyState>
  );
}
