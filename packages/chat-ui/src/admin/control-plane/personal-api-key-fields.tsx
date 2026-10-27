import { useState } from "react";
import { Checkbox, Field, Input, Picker, PickerButton, Select } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { actionLabel } from "../access/right-words";
import {
  PERSONAL_KEY_EXPIRY_DAYS,
  isPersonalKeyInstanceAction,
  personalKeyDraftProblem,
  personalKeyExpiryOf,
  type PersonalKeyDraft
} from "./personal-api-keys-model";

/** From this many workspaces on, the workspace picker shows its search field. */
const WORKSPACE_SEARCH_FROM_COUNT = 8;

/** A workspace a key can be limited to: one whose own assets the person holds a right on. */
export interface PersonalKeyWorkspace {
  id: string;
  /** Absent for the person's Personal Workspace, which is named "Personal". */
  name?: string;
}

/**
 * The name, the scopes and the end of a personal key: the same fields for a new key and for a
 * CLI's connect code. The scopes are actions, each named as the rights screens name it, all
 * limited to what one workspace owns where one is chosen, and within it to one asset where its
 * id is given. The instance level is offered only while no workspace is chosen, and choosing one
 * unticks it.
 */
export function PersonalKeyFields({
  draft,
  actions,
  useActions,
  instanceActions = [],
  workspaces,
  onChange
}: {
  draft: PersonalKeyDraft;
  /** The actions offered, in order, by their ids. */
  actions: readonly string[];
  /** The use level offered, in order: the use rights the person holds. */
  useActions: readonly string[];
  /** The instance level offered: `system.view` where the person holds it. */
  instanceActions?: readonly string[];
  /** The workspaces the key can be limited to. */
  workspaces: readonly PersonalKeyWorkspace[];
  onChange(draft: PersonalKeyDraft): void;
}) {
  const { t } = useTranslation();
  // A wrong id is said once the person left the field, not at every keystroke.
  const [assetTouched, setAssetTouched] = useState(false);
  const problem = personalKeyDraftProblem(draft);
  const workspaceLabel = (workspace: PersonalKeyWorkspace) =>
    workspace.name ?? t("personalApiKeys.workspacePersonal");
  const chosenWorkspace = workspaces.find((workspace) => workspace.id === draft.workspaceId);
  const offered = [...actions, ...useActions, ...instanceActions];
  const toggle = (action: string) => (checked: boolean) =>
    onChange({
      ...draft,
      actions: checked
        ? offered.filter((item) => item === action || draft.actions.includes(item))
        : draft.actions.filter((item) => item !== action)
    });
  const boxes = (list: readonly string[]) => (
    <div className="grid gap-2">
      {list.map((action) => (
        <Checkbox
          key={action}
          label={actionLabel(action, t)}
          checked={draft.actions.includes(action)}
          onCheckedChange={toggle(action)}
        />
      ))}
    </div>
  );

  return (
    <div className="grid gap-5">
      <Field label={t("personalApiKeys.name")} required hint={t("personalApiKeys.nameHint")}>
        <Input
          value={draft.name}
          maxLength={100}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-label">{t("personalApiKeys.actions")}</legend>
        <p className="text-caption text-muted-foreground">{t("personalApiKeys.actionsHint")}</p>
        {boxes(actions)}
      </fieldset>
      {useActions.length > 0 ? (
        <fieldset className="grid gap-2">
          <legend className="text-label">{t("personalApiKeys.useLevel")}</legend>
          <p className="text-caption text-muted-foreground">{t("personalApiKeys.useLevelHint")}</p>
          {boxes(useActions)}
        </fieldset>
      ) : null}
      {instanceActions.length > 0 && !draft.workspaceId ? (
        <fieldset className="grid gap-2">
          <legend className="text-label">{t("personalApiKeys.instanceLevel")}</legend>
          <p className="text-caption text-muted-foreground">
            {t("personalApiKeys.instanceLevelHint")}
          </p>
          {boxes(instanceActions)}
        </fieldset>
      ) : null}
      <Field label={t("personalApiKeys.workspace")} hint={t("personalApiKeys.workspaceHint")}>
        <Picker
          search={workspaces.length >= WORKSPACE_SEARCH_FROM_COUNT}
          options={[
            { value: "", label: t("personalApiKeys.workspaceEverywhere") },
            ...workspaces.map((workspace) => ({
              value: workspace.id,
              label: workspaceLabel(workspace)
            }))
          ]}
          value={draft.workspaceId}
          onValueChange={(workspaceId) =>
            onChange({
              ...draft,
              workspaceId,
              ...(workspaceId
                ? {
                    // A workspace narrows the key: the instance level does not go with it.
                    actions: draft.actions.filter((action) => !isPersonalKeyInstanceAction(action))
                  }
                : { assetName: "" })
            })
          }
        >
          <PickerButton
            label={t("personalApiKeys.workspace")}
            value={chosenWorkspace ? workspaceLabel(chosenWorkspace) : undefined}
            placeholder={t("personalApiKeys.workspaceEverywhere")}
          />
        </Picker>
      </Field>
      {draft.workspaceId ? (
        <Field
          label={t("personalApiKeys.asset")}
          optional
          hint={t("personalApiKeys.assetHint")}
          error={
            assetTouched && problem === "assetName" ? t("personalApiKeys.assetInvalid") : undefined
          }
        >
          <Input
            className="font-mono"
            value={draft.assetName}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            onBlur={() => setAssetTouched(true)}
            onChange={(event) => onChange({ ...draft, assetName: event.target.value })}
          />
        </Field>
      ) : null}
      <Field label={t("personalApiKeys.expiry")}>
        <Select
          value={String(draft.expiryDays)}
          onChange={(event) => {
            const expiryDays = personalKeyExpiryOf(event.target.value);
            if (expiryDays) onChange({ ...draft, expiryDays });
          }}
        >
          {PERSONAL_KEY_EXPIRY_DAYS.map((days) => (
            <option key={days} value={String(days)}>
              {t("personalApiKeys.expiryDays", { days })}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
