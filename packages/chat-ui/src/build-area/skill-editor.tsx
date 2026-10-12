import { FileText, Plus, X } from "lucide-react";
import { useState } from "react";
import { SKILL_RESOURCE_MEDIA_TYPES } from "@vivd-catalyst/core";
import { Button, Field, Input, List, ListRow, Select, Textarea } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { AssetEditorShell, useAssetForm, type AssetSection } from "./asset-editor-shell";
import {
  SKILL_ROOT_FILE_NAME,
  countChangedFields,
  skillFormToConfig,
  type SkillFormState
} from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";

type SkillResource = SkillFormState["resources"][number];

export function SkillEditor({
  frame,
  initialForm,
  editable: instanceEditable
}: {
  frame: BuildAssetEditorProps;
  initialForm: SkillFormState;
  /** The instance lets people change skills here. */
  editable: boolean;
}) {
  const { t } = useTranslation();
  const state = useAssetForm(initialForm);
  const { form, setForm, outcome } = state;
  const [saving, setSaving] = useState(false);
  const [selectedResource, setSelectedResource] = useState<"root" | number>("root");
  const editable = frame.canWrite && instanceEditable;

  const update = (patch: Partial<SkillFormState>) => setForm((value) => ({ ...value, ...patch }));
  const submit = async () => {
    setSaving(true);
    const answer = await frame.save(skillFormToConfig(form));
    setSaving(false);
    state.setOutcome(answer);
    if (answer.ok) {
      state.markSaved();
    }
    return answer;
  };
  const addResource = () => {
    const used = new Set(form.resources.map((resource) => resource.path));
    let number = 1;
    let path = "references/reference.md";
    while (used.has(path)) {
      number += 1;
      path = `references/reference-${number}.md`;
    }
    setSelectedResource(form.resources.length);
    update({ resources: [...form.resources, { path, mediaType: "text/markdown", content: "" }] });
  };
  const resource = selectedResource === "root" ? undefined : form.resources[selectedResource];

  const sections: AssetSection[] = [
    {
      id: "details",
      label: t("configSkillDetails"),
      description: t("configSkillDetailsDescription"),
      body: (
        <>
          <Field label={t("configTitle")} hint={t("configSkillTitleHint")} required={editable}>
            <Input
              value={form.title}
              readOnly={!editable}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <Field
            label={t("configDescription")}
            hint={t("configSkillDescriptionHint")}
            required={editable}
          >
            <Input
              value={form.description}
              readOnly={!editable}
              onChange={(event) => update({ description: event.target.value })}
            />
          </Field>
        </>
      )
    },
    {
      id: "instructions",
      label: t("configInstructions"),
      description: t("configSkillInstructionsDescription"),
      count: form.resources.length > 0 ? form.resources.length + 1 : undefined,
      body: (
        <>
          {form.resources.length > 0 || editable ? (
            <div className="grid gap-2">
              <List aria-label={t("build.skillFiles")}>
                <ListRow
                  size="compact"
                  leading={<FileText aria-hidden="true" />}
                  title={SKILL_ROOT_FILE_NAME}
                  selected={selectedResource === "root"}
                  onClick={() => setSelectedResource("root")}
                />
                {form.resources.map((entry, index) => (
                  <ListRow
                    key={`${index}:${entry.path}`}
                    size="compact"
                    leading={<FileText aria-hidden="true" />}
                    title={entry.path}
                    selected={selectedResource === index}
                    onClick={() => setSelectedResource(index)}
                  />
                ))}
              </List>
              {editable ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={addResource}
                >
                  <Plus aria-hidden="true" />
                  {t("configAddResource")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {resource === undefined || selectedResource === "root" ? (
            <Field
              label={t("configContent")}
              hint={t("configSkillContentHint")}
              required={editable}
            >
              <Textarea
                variant="code"
                className="min-h-96"
                value={form.content}
                readOnly={!editable}
                onChange={(event) => update({ content: event.target.value })}
              />
            </Field>
          ) : (
            <SkillResourceEditor
              resource={resource}
              editable={editable}
              onChange={(next) =>
                update({
                  resources: form.resources.map((candidate, index) =>
                    index === selectedResource ? next : candidate
                  )
                })
              }
              onRemove={() => {
                update({
                  resources: form.resources.filter((_, index) => index !== selectedResource)
                });
                setSelectedResource("root");
              }}
            />
          )}
        </>
      )
    }
  ];

  return (
    <AssetEditorShell
      frame={{ ...frame, canWrite: editable }}
      title={form.title.trim() || form.name}
      sections={sections}
      control={{
        changes: countChangedFields(form, state.baseline),
        submit,
        discard: state.discard
      }}
      outcome={outcome}
      saving={saving}
      saveLabel={frame.asset ? t("configSaveChanges") : t("configCreateSkill")}
    />
  );
}

function SkillResourceEditor({
  resource,
  editable,
  onChange,
  onRemove
}: {
  resource: SkillResource;
  editable: boolean;
  onChange(resource: SkillResource): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <Field label={t("configResourcePath")} required={editable}>
          <Input
            value={resource.path}
            readOnly={!editable}
            onChange={(event) => onChange({ ...resource, path: event.target.value })}
          />
        </Field>
        <Field label={t("configResourceType")}>
          <Select
            value={resource.mediaType}
            disabled={!editable}
            onChange={(event) => onChange({ ...resource, mediaType: event.target.value })}
          >
            {SKILL_RESOURCE_MEDIA_TYPES.map((mediaType) => (
              <option key={mediaType} value={mediaType}>
                {mediaType}
              </option>
            ))}
          </Select>
        </Field>
        {editable ? (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <X aria-hidden="true" />
            {t("configRemove")}
          </Button>
        ) : null}
      </div>
      <Field label={t("configResourceContent")}>
        <Textarea
          variant="code"
          className="min-h-96"
          value={resource.content}
          readOnly={!editable}
          onChange={(event) => onChange({ ...resource, content: event.target.value })}
        />
      </Field>
    </>
  );
}
