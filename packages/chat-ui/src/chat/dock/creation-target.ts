import type { TranslationKey } from "../../shared/i18n";

/**
 * Where an asset the dock's agent creates will belong: the workspace of the conversation, or the
 * instance. The dock's start page says it in one line under its greeting, read from here alone,
 * so a later target changes no interface.
 */
export type CreationTarget = { owner: "workspace"; workspaceName: string } | { owner: "instance" };

/**
 * The target of a new asset of `kind` made in a conversation of the open workspace: that
 * workspace where the kind can be owned by one (WS-OWN-1a), else the instance. Nothing while the
 * instance has not said who may own the kind, or the workspace's name is not known.
 */
export function dockCreationTarget({
  owners,
  workspaceName
}: {
  /** Who may own an asset of the kind, as the instance's context says. */
  owners: readonly string[] | undefined;
  /** The name of the open workspace, as people read it. */
  workspaceName: string | undefined;
}): CreationTarget | undefined {
  if (owners === undefined) return undefined;
  if (owners.includes("workspace")) {
    return workspaceName === undefined ? undefined : { owner: "workspace", workspaceName };
  }
  return owners.includes("instance") ? { owner: "instance" } : undefined;
}

/** The kinds in the plural, as the line under the greeting names them. */
const KIND_PLURALS: Readonly<Record<string, TranslationKey>> = {
  agent: "dock.pluralAgents",
  skill: "dock.pluralSkills",
  guardrail: "dock.pluralGuardrails",
  data_store: "dock.pluralDataStores",
  knowledge_base: "dock.pluralKnowledgeBases",
  workflow: "dock.pluralWorkflows",
  app: "dock.pluralApps"
};

/** The line under the greeting of an empty dock that builds: where a new asset will belong. */
export function creationTargetLine(
  kind: string,
  target: CreationTarget,
  t: (key: TranslationKey, values?: Record<string, string>) => string
): string | undefined {
  const plural = KIND_PLURALS[kind];
  if (plural === undefined) return undefined;
  return target.owner === "workspace"
    ? t("dock.createdInWorkspace", { things: t(plural), workspace: target.workspaceName })
    : t("dock.createdInInstance", { things: t(plural) });
}
