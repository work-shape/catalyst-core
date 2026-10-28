import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import type { AdministeredCollaborationWorkspace } from "@work-shape/catalyst-api-client";
import { Checkbox, RadioGroup } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { CheckboxGroup, FieldRefusals } from "./asset-form-fields";
import {
  agentAvailabilityFormsEqual,
  agentAvailabilityToForm,
  type AgentAvailabilityForm
} from "./asset-form-model";
import { MissingDependencies, type DependencyAvailability } from "./dependency-availability";

/**
 * Where an agent, a Knowledge Base or a Connection is available. It is stored beside the
 * asset's definition and set by whoever may change what belongs to the whole instance.
 */
export interface AvailabilityChoice {
  saved: AgentAvailabilityForm | undefined;
  /** Why the availability cannot be changed, such as for what is "Only me": the fields grey. */
  fixedReason?: string;
  workspaces: readonly AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  /**
   * An agent's: what it uses that members could not use where the form makes it available,
   * read without changing anything. Left out for a kind that uses nothing.
   */
  dependencies?: {
    key: QueryKey;
    read(form: AgentAvailabilityForm, signal: AbortSignal): Promise<DependencyAvailability | null>;
    /**
     * The same for a definition that is not live yet, such as the draft a publish makes live:
     * what it would use that members could not use where the form makes it available.
     */
    readFor?(
      config: Record<string, unknown>,
      form: AgentAvailabilityForm,
      signal: AbortSignal
    ): Promise<DependencyAvailability | null>;
  };
  /** Answers with what went wrong, if anything did. */
  save(
    availability: AgentAvailabilityForm,
    options: { makeDependenciesAvailable: boolean }
  ): Promise<string | undefined>;
  /**
   * The same save right after a publish of the agent: against the live revision the publish
   * made, which the page has not read yet, and the availability the page showed.
   */
  saveAfterPublish?(
    availability: AgentAvailabilityForm,
    options: { makeDependenciesAvailable: boolean }
  ): Promise<string | undefined>;
}

/** The availability as a page edits it: the form, whether it changed, and its save. */
interface AvailabilityEdit {
  form: AgentAvailabilityForm;
  setForm(form: AgentAvailabilityForm): void;
  changed: boolean;
  /**
   * The reader chose to make what the agent uses available along with the change. Every change
   * of the form clears it: it was chosen for the missing list of the form as it was.
   */
  makeDependenciesAvailable: boolean;
  setMakeDependenciesAvailable(on: boolean): void;
  /** Saves the form. Answers with what went wrong, if anything did. */
  save(): Promise<string | undefined>;
  discard(): void;
}

export function useAvailabilityEdit(
  choice: AvailabilityChoice | undefined,
  /** A choice the reader made that was not saved: the form starts from it. */
  unsaved?: AgentAvailabilityForm
): AvailabilityEdit {
  const saved = useMemo(() => agentAvailabilityToForm(choice?.saved), [choice?.saved]);
  const [form, setForm] = useState(unsaved ?? saved);
  const [makeDependenciesAvailable, setMakeDependenciesAvailable] = useState(false);
  // A save made elsewhere on the page, such as a publish that offers the agent, moves an
  // untouched form along; a form the reader changed keeps what they chose.
  const [base, setBase] = useState(saved);
  if (base !== saved) {
    setBase(saved);
    if (agentAvailabilityFormsEqual(form, base)) setForm(saved);
  }
  const changed = choice !== undefined && !agentAvailabilityFormsEqual(form, saved);
  return {
    form,
    setForm: (next) => {
      setForm(next);
      setMakeDependenciesAvailable(false);
    },
    changed,
    makeDependenciesAvailable,
    setMakeDependenciesAvailable,
    save: async () => {
      if (choice === undefined) return undefined;
      const refused = await choice.save(form, { makeDependenciesAvailable });
      if (refused === undefined) setMakeDependenciesAvailable(false);
      return refused;
    },
    discard: () => {
      setForm(saved);
      setMakeDependenciesAvailable(false);
    }
  };
}

/**
 * Where an asset is available, as the fields of its section. The section's heading names it.
 * Under the fields stands what a changed availability leaves the agent's members unable to use.
 */
export function AvailabilityFields({
  edit,
  locked = false,
  fixedReason,
  disabled,
  workspaces,
  workspacesError,
  hiddenHint,
  dependencies,
  refusals
}: {
  edit: AvailabilityEdit;
  /** The default agent is offered everywhere, and stays so until another agent is the default. */
  locked?: boolean;
  /** Why the availability cannot be changed at all: the fields grey, with this as their hint. */
  fixedReason?: string;
  disabled: boolean;
  workspaces: readonly AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  /** What it means that nothing is selected, for this kind. */
  hiddenHint: string;
  /** An agent's: what a changed availability would leave its members unable to use. */
  dependencies?: AvailabilityChoice["dependencies"];
  refusals: readonly string[];
}) {
  const { t } = useTranslation();
  const { form } = edit;
  const fixed = locked || disabled || fixedReason !== undefined;
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  // Ids the list no longer returns stay visible, so saving never drops them unseen.
  const workspaceIds = [
    ...workspaces.map((workspace) => workspace.id),
    ...form.collaborationWorkspaceIds.filter((id) => !workspaceNames.has(id))
  ];
  const nothingSelected =
    form.mode === "selected" &&
    !form.personalWorkspaces &&
    form.collaborationWorkspaceIds.length === 0;
  const update = (patch: Partial<AgentAvailabilityForm>) => edit.setForm({ ...form, ...patch });

  return (
    <>
      <RadioGroup
        variant="plain"
        label={t("configAvailability")}
        labelHidden
        hint={fixedReason ?? (locked ? t("configAvailabilityDefaultLocked") : undefined)}
        disabled={fixed}
        value={form.mode}
        onValueChange={(mode) => update({ mode })}
        options={[
          {
            value: "all",
            label: t("configAvailabilityAll"),
            description: t("configAvailabilityAllHint")
          },
          { value: "selected", label: t("configAvailabilitySelected") }
        ]}
      />

      {form.mode === "selected" ? (
        <>
          <Checkbox
            checked={form.personalWorkspaces}
            disabled={fixed}
            label={t("configAvailabilityPersonal")}
            description={t("configAvailabilityPersonalHint")}
            onCheckedChange={(personalWorkspaces) => update({ personalWorkspaces })}
          />
          <CheckboxGroup
            label={t("collaborationWorkspaceSharedHeading")}
            options={workspaceIds}
            optionLabel={(id) => workspaceNames.get(id) ?? id}
            selected={form.collaborationWorkspaceIds}
            disabled={fixed}
            emptyHint={workspacesError ?? t("configAvailabilityNoSharedWorkspaces")}
            hint={nothingSelected ? hiddenHint : undefined}
            onChange={(collaborationWorkspaceIds) => update({ collaborationWorkspaceIds })}
          />
        </>
      ) : null}

      {edit.changed && dependencies ? (
        <ChangedDependencies
          edit={edit}
          dependencies={dependencies}
          workspaceName={(id) => workspaceNames.get(id)}
          disabled={disabled}
        />
      ) : null}
      <FieldRefusals messages={refusals} />
    </>
  );
}

/**
 * What the changed availability would leave missing, read for the form as it is. The choice to
 * make it available shows only with the list it was read for.
 */
function ChangedDependencies({
  edit,
  dependencies,
  workspaceName,
  disabled
}: {
  edit: AvailabilityEdit;
  dependencies: NonNullable<AvailabilityChoice["dependencies"]>;
  workspaceName(id: string): string | undefined;
  disabled: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const { form } = edit;
  const read = useQuery({
    queryKey: [...dependencies.key, form],
    queryFn: ({ signal }) => dependencies.read(form, signal),
    retry: false
  });
  // Nothing shows while the check is on its way: most changes miss nothing.
  if (read.isPending) return null;
  if (read.isError) {
    return (
      <p className="text-caption text-muted-foreground" data-dependencies-failed="">
        {t("configAvailabilityMissingFailed")}
      </p>
    );
  }
  return (
    <MissingDependencies
      dependencies={read.data ?? undefined}
      availability={form}
      workspaceName={workspaceName}
      makeAvailable={edit.makeDependenciesAvailable}
      disabled={disabled}
      onMakeAvailableChange={edit.setMakeDependenciesAvailable}
    />
  );
}
