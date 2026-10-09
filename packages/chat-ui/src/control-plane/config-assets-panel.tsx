import { Bot, BookOpen, Plus, Star } from "lucide-react";
import { useState } from "react";
import type {
  AdministeredCollaborationWorkspace,
  ConfigAssetKind,
  ConfigAssetRevision,
  ConfigAssetsOverview
} from "@vivd-catalyst/api-client";
import { Banner, Button, cn, Dialog, PageHeader, SkeletonPage } from "@vivd-catalyst/ui";
import {
  agentAvailabilitySummary,
  agentConfigToForm,
  editedAgentConfig,
  configAssetMutationErrorMessage,
  emptyAgentForm,
  emptySkillForm,
  skillConfigToForm,
  skillFormToConfig,
  type AgentAvailabilityForm
} from "./config-assets-model";
import {
  AgentAvailabilityEditor,
  AgentEditor,
  RevisionHistory,
  SkillEditor
} from "./config-asset-editors";
import { useTranslation } from "../i18n";
import { apiErrorStatus } from "../workspace-utils";

export interface ConfigAssetBundleEntry {
  name: string;
  config: Record<string, unknown>;
}

export interface ConfigAssetsPanelInput {
  editableAgentFields: string[];
  canManageAgentModels: boolean;
  allowAgentCreation: boolean;
  allowAgentDeletion: boolean;
  allowDefaultAgentChange: boolean;
  allowSkillEditing: boolean;
  overview: ConfigAssetsOverview | undefined;
  agents: ConfigAssetBundleEntry[];
  skills: ConfigAssetBundleEntry[];
  /** Shared Workspaces an agent can be made available in. */
  administeredWorkspaces: AdministeredCollaborationWorkspace[];
  administeredWorkspacesError?: string;
  loading: boolean;
  error?: string;
  mutating: boolean;
  onSaveAsset(input: {
    kind: ConfigAssetKind;
    name: string;
    config: Record<string, unknown>;
    baseVersion?: number;
  }): Promise<unknown>;
  onDeleteAsset(input: {
    kind: ConfigAssetKind;
    name: string;
    baseVersion?: number;
  }): Promise<unknown>;
  onSetDefaultAgent(input: { agentName?: string; baseVersion?: number }): Promise<unknown>;
  onSetAgentAvailability(input: { name: string } & AgentAvailabilityForm): Promise<unknown>;
  onRevertAsset(input: {
    kind: ConfigAssetKind;
    name: string;
    revision: number;
    baseVersion?: number;
  }): Promise<unknown>;
  onLoadRevisions(kind: ConfigAssetKind, name: string): Promise<ConfigAssetRevision[]>;
  onReload(): Promise<unknown>;
}

interface MutationOutcome {
  ok: boolean;
  error?: string;
}

type PanelSelection =
  | { mode: "existing"; kind: ConfigAssetKind; name: string }
  | { mode: "new"; kind: ConfigAssetKind };

export function ConfigAssetsPanel(input: ConfigAssetsPanelInput) {
  const { locale, t } = useTranslation();
  const [selection, setSelection] = useState<PanelSelection | undefined>(undefined);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  const version = input.overview?.version;
  const defaultAgentName = input.overview?.defaultAgentName;
  const agentNames = input.agents.map((agent) => agent.name);
  const agentAvailability = new Map(
    (input.overview?.assets ?? [])
      .filter((asset) => asset.kind === "agent")
      .map((asset) => [asset.name, asset.availability])
  );
  const availabilityLabel = (name: string) => {
    const summary = agentAvailabilitySummary(agentAvailability.get(name));
    if (summary.kind === "all") return t("configAvailabilityAll");
    if (summary.kind === "hidden") return t("configAvailabilityHidden");
    if (summary.kind === "personal") return t("configAvailabilityPersonal");
    const count = summary.count.toLocaleString(locale);
    return summary.personalWorkspaces
      ? t("configAvailabilityPersonalPlus", { count })
      : t(
          summary.count === 1
            ? "configAvailabilityWorkspaceCount"
            : "configAvailabilityWorkspaceCountPlural",
          { count }
        );
  };
  const skillNames = input.skills.map((skill) => skill.name);
  const pageDescription = (
    <>
      {t(agentNames.length === 1 ? "configAgentCount" : "configAgentCountPlural", {
        count: agentNames.length.toLocaleString(locale)
      })}
      {" · "}
      {t(skillNames.length === 1 ? "configSkillCount" : "configSkillCountPlural", {
        count: skillNames.length.toLocaleString(locale)
      })}
      {version !== undefined ? ` · ${t("configVersion", { version })}` : ""}
    </>
  );

  const selectedEntry =
    selection?.mode === "existing"
      ? (selection.kind === "agent" ? input.agents : input.skills).find(
          (entry) => entry.name === selection.name
        )
      : undefined;

  const runMutation = async (action: () => Promise<unknown>): Promise<MutationOutcome> => {
    try {
      await action();
      return { ok: true };
    } catch (error) {
      if (apiErrorStatus(error) === 409) {
        setConflictOpen(true);
        return { ok: false };
      }
      return {
        ok: false,
        error: configAssetMutationErrorMessage(error, t("configChangeSaveFailed"))
      };
    }
  };

  const reloadAfterConflict = async () => {
    await input.onReload();
    setConflictOpen(false);
    setResetToken((token) => token + 1);
  };

  if (input.loading) {
    return (
      <>
        <PageHeader title={t("nav.build")} description={pageDescription} />
        <SkeletonPage />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("nav.build")}
        description={pageDescription}
        secondaryActions={
          <>
            {input.allowSkillEditing ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setSelection({ mode: "new", kind: "skill" })}
              >
                <Plus size={16} aria-hidden="true" />
                {t("configNewSkill")}
              </Button>
            ) : null}
            {input.allowAgentCreation ? (
              <Button type="button" onClick={() => setSelection({ mode: "new", kind: "agent" })}>
                <Plus size={16} aria-hidden="true" />
                {t("configNewAgent")}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid min-w-0 content-start gap-4">
        {input.error ? <Banner tone="danger">{input.error}</Banner> : null}

        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="grid min-w-0 content-start gap-4 overflow-hidden rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-2 lg:sticky lg:top-0 lg:grid-cols-1">
            <AssetList
              label={t("configAgents")}
              creatingLabel={t("configCreatingAgent")}
              emptyLabel={t("configNoneYet")}
              icon={<Bot size={14} aria-hidden="true" />}
              names={agentNames}
              describe={availabilityLabel}
              decorate={(name) =>
                name === defaultAgentName ? (
                  <span
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-primary"
                    title={t("configDefaultAgent")}
                    aria-label={t("configDefaultAgent")}
                  >
                    <Star size={13} aria-hidden="true" />
                  </span>
                ) : null
              }
              selectedName={
                selection?.mode === "existing" && selection.kind === "agent"
                  ? selection.name
                  : undefined
              }
              creating={selection?.mode === "new" && selection.kind === "agent"}
              onSelect={(name) => setSelection({ mode: "existing", kind: "agent", name })}
            />
            <AssetList
              label={t("configSkills")}
              creatingLabel={t("configCreatingSkill")}
              emptyLabel={t("configNoneYet")}
              icon={<BookOpen size={14} aria-hidden="true" />}
              names={skillNames}
              decorate={() => null}
              selectedName={
                selection?.mode === "existing" && selection.kind === "skill"
                  ? selection.name
                  : undefined
              }
              creating={selection?.mode === "new" && selection.kind === "skill"}
              onSelect={(name) => setSelection({ mode: "existing", kind: "skill", name })}
            />
            {version !== undefined ? (
              <p className="border-t px-1 pt-3 text-xs leading-5 text-muted-foreground sm:col-span-2 lg:col-span-1">
                {t("configCliHint")}
              </p>
            ) : null}
          </aside>

          <div className="min-w-0 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs">
            {selection === undefined ? (
              <div className="grid min-h-[28rem] place-items-center p-6 text-center">
                <div className="grid max-w-sm justify-items-center gap-3">
                  <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Bot size={18} aria-hidden="true" />
                  </span>
                  <div className="grid gap-1">
                    <h2 className="text-base font-semibold">{t("configSelectItemTitle")}</h2>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {t("configSelectItemDescription")}
                    </p>
                  </div>
                </div>
              </div>
            ) : selection.kind === "agent" ? (
              <AgentEditor
                key={`${resetToken}:${selectionKey(selection)}:${selectedEntry ? "loaded" : "pending"}`}
                initialForm={
                  selection.mode === "existing" && selectedEntry
                    ? agentConfigToForm(selectedEntry.config)
                    : emptyAgentForm()
                }
                isNew={selection.mode === "new"}
                isDefault={selection.mode === "existing" && selection.name === defaultAgentName}
                references={input.overview?.references}
                editableAgentFields={input.editableAgentFields}
                canManageAgentModels={input.canManageAgentModels}
                skillNames={skillNames}
                mutating={input.mutating}
                onSave={(form) =>
                  runMutation(() =>
                    input
                      .onSaveAsset({
                        kind: "agent",
                        name: form.name.trim(),
                        config: editedAgentConfig(
                          form,
                          selection.mode === "existing" ? selectedEntry?.config : undefined
                        ),
                        baseVersion: version
                      })
                      .then(() => {
                        if (selection.mode === "new") {
                          setSelection({ mode: "existing", kind: "agent", name: form.name.trim() });
                        }
                      })
                  )
                }
                onDelete={
                  selection.mode === "existing" && input.allowAgentDeletion
                    ? () =>
                        runMutation(() =>
                          input
                            .onDeleteAsset({
                              kind: "agent",
                              name: selection.name,
                              baseVersion: version
                            })
                            .then(() => setSelection(undefined))
                        )
                    : undefined
                }
                onMakeDefault={
                  selection.mode === "existing" &&
                  selection.name !== defaultAgentName &&
                  input.allowDefaultAgentChange
                    ? () =>
                        runMutation(() =>
                          input.onSetDefaultAgent({
                            agentName: selection.name,
                            baseVersion: version
                          })
                        )
                    : undefined
                }
                availability={
                  selection.mode === "existing" && selectedEntry ? (
                    <AgentAvailabilityEditor
                      availability={agentAvailability.get(selection.name)}
                      isDefault={selection.name === defaultAgentName}
                      workspaces={input.administeredWorkspaces}
                      workspacesError={input.administeredWorkspacesError}
                      mutating={input.mutating}
                      onSave={(availability) =>
                        runMutation(() =>
                          input.onSetAgentAvailability({ name: selection.name, ...availability })
                        )
                      }
                    />
                  ) : null
                }
                revisions={
                  selection.mode === "existing" ? (
                    <RevisionHistory
                      kind="agent"
                      name={selection.name}
                      mutating={input.mutating}
                      onLoadRevisions={input.onLoadRevisions}
                      onRevert={
                        input.editableAgentFields.length > 0 || input.canManageAgentModels
                          ? (revision) =>
                              runMutation(() =>
                                input
                                  .onRevertAsset({
                                    kind: "agent",
                                    name: selection.name,
                                    revision,
                                    baseVersion: version
                                  })
                                  .then(() => setResetToken((token) => token + 1))
                              )
                          : undefined
                      }
                    />
                  ) : null
                }
              />
            ) : (
              <SkillEditor
                key={`${resetToken}:${selectionKey(selection)}:${selectedEntry ? "loaded" : "pending"}`}
                initialForm={
                  selection.mode === "existing" && selectedEntry
                    ? skillConfigToForm(selectedEntry.config)
                    : emptySkillForm()
                }
                isNew={selection.mode === "new"}
                editable={input.allowSkillEditing}
                mutating={input.mutating}
                onSave={(form) =>
                  runMutation(() =>
                    input
                      .onSaveAsset({
                        kind: "skill",
                        name: form.name.trim(),
                        config: skillFormToConfig(form),
                        baseVersion: version
                      })
                      .then(() => {
                        if (selection.mode === "new") {
                          setSelection({ mode: "existing", kind: "skill", name: form.name.trim() });
                        }
                      })
                  )
                }
                onDelete={
                  selection.mode === "existing" && input.allowSkillEditing
                    ? () =>
                        runMutation(() =>
                          input
                            .onDeleteAsset({
                              kind: "skill",
                              name: selection.name,
                              baseVersion: version
                            })
                            .then(() => setSelection(undefined))
                        )
                    : undefined
                }
                revisions={
                  selection.mode === "existing" ? (
                    <RevisionHistory
                      kind="skill"
                      name={selection.name}
                      mutating={input.mutating}
                      onLoadRevisions={input.onLoadRevisions}
                      onRevert={
                        input.allowSkillEditing
                          ? (revision) =>
                              runMutation(() =>
                                input
                                  .onRevertAsset({
                                    kind: "skill",
                                    name: selection.name,
                                    revision,
                                    baseVersion: version
                                  })
                                  .then(() => setResetToken((token) => token + 1))
                              )
                          : undefined
                      }
                    />
                  ) : null
                }
              />
            )}
          </div>
        </div>

        <Dialog
          open={conflictOpen}
          title={t("configChangedTitle")}
          onClose={() => setConflictOpen(false)}
        >
          <div className="grid gap-4 p-5">
            <p className="text-sm text-muted-foreground">{t("configChangedDescription")}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConflictOpen(false)}>
                {t("configKeepEditing")}
              </Button>
              <Button onClick={() => void reloadAfterConflict()}>{t("configReloadLatest")}</Button>
            </div>
          </div>
        </Dialog>
      </div>
    </>
  );
}

function selectionKey(selection: PanelSelection): string {
  return selection.mode === "new" ? `new:${selection.kind}` : `${selection.kind}:${selection.name}`;
}

function AssetList({
  label,
  creatingLabel,
  emptyLabel,
  icon,
  names,
  describe,
  decorate,
  selectedName,
  creating,
  onSelect
}: {
  label: string;
  creatingLabel: string;
  emptyLabel: string;
  icon: React.ReactNode;
  names: string[];
  /** A second, muted line under the name. */
  describe?: (name: string) => string;
  decorate(name: string): React.ReactNode;
  selectedName: string | undefined;
  creating: boolean;
  onSelect(name: string): void;
}) {
  return (
    <section className="grid min-w-0 gap-1.5 overflow-hidden" aria-label={label}>
      <div className="flex min-h-7 items-center justify-between gap-2 px-1">
        <h2 className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {icon}
          {label}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{names.length}</span>
      </div>
      <ul className="grid min-w-0 gap-1 overflow-hidden">
        {names.map((name) => (
          <li key={name} className="min-w-0 overflow-hidden">
            <button
              type="button"
              className={cn(
                "flex min-h-9 w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-md px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                selectedName === name &&
                  "bg-primary/10 font-medium text-foreground hover:bg-primary/15"
              )}
              title={name}
              onClick={() => onSelect(name)}
            >
              <span className="grid min-w-0 flex-1 gap-0.5 py-1.5">
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs">
                  {name}
                </span>
                {describe ? (
                  <span className="truncate text-[11px] font-normal text-muted-foreground">
                    {describe(name)}
                  </span>
                ) : null}
              </span>
              {decorate(name)}
            </button>
          </li>
        ))}
        {creating ? (
          <li className="rounded-md bg-muted px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {creatingLabel}
          </li>
        ) : null}
        {names.length === 0 && !creating ? (
          <li className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</li>
        ) : null}
      </ul>
    </section>
  );
}
