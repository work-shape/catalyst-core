import type { AdministeredCollaborationWorkspace } from "@work-shape/catalyst-api-client";
import { Checkbox, RadioGroup } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { CheckboxGroup, FieldRefusals } from "./asset-form-fields";
import type { AgentAvailabilityForm } from "./asset-form-model";

/**
 * Where an agent can be chosen. It is stored beside the agent's definition and saved with it
 * through the page's save bar, whichever agent fields the instance lets people change.
 */
export interface AgentAvailabilityChoice {
  saved: AgentAvailabilityForm | undefined;
  workspaces: readonly AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  /** Answers with what went wrong, if anything did. */
  save(availability: AgentAvailabilityForm): Promise<string | undefined>;
}

/**
 * Where an agent can be chosen, as the fields of its section. The section's heading names it,
 * and the page's save bar saves it with the agent.
 */
export function AgentAvailabilityFields({
  form,
  locked,
  disabled,
  workspaces,
  workspacesError,
  refusals,
  onChange
}: {
  form: AgentAvailabilityForm;
  /** The default agent is offered everywhere, and stays so until another agent is the default. */
  locked: boolean;
  disabled: boolean;
  workspaces: readonly AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  refusals: readonly string[];
  onChange(form: AgentAvailabilityForm): void;
}) {
  const { t } = useTranslation();
  const fixed = locked || disabled;
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
  const update = (patch: Partial<AgentAvailabilityForm>) => onChange({ ...form, ...patch });

  return (
    <>
      <RadioGroup
        variant="plain"
        label={t("configAvailability")}
        labelHidden
        hint={locked ? t("configAvailabilityDefaultLocked") : undefined}
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
            hint={nothingSelected ? t("configAvailabilityHiddenHint") : undefined}
            onChange={(collaborationWorkspaceIds) => update({ collaborationWorkspaceIds })}
          />
        </>
      ) : null}

      <FieldRefusals messages={refusals} />
    </>
  );
}
