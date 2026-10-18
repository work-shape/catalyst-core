import { Checkbox, Field, Select } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { modelDisplayLabel } from "../../shared/model-label";
import { reasoningEffortLabel } from "../../shared/reasoning-effort-label";
import { agentModelReasoningEffort, agentModelRows, type AgentFormState } from "./asset-form-model";

/**
 * The agent's models: which one runs the agent, and which ones its users may pick instead.
 * Read-only, the list below the default holds only the models people may choose.
 */
export function AgentModels({
  form,
  modelBindings,
  reasoningEfforts,
  editable,
  setByModelManagers,
  onSelectDefault,
  onSetUserSelectable,
  onSetReasoningEffort
}: {
  form: AgentFormState;
  modelBindings: readonly { id: string; model: string; label?: string }[];
  reasoningEfforts: readonly string[];
  editable: boolean;
  /** The reader may change the agent but not its models: the default model says who may. */
  setByModelManagers: boolean;
  onSelectDefault(modelBindingId: string): void;
  onSetUserSelectable(modelBindingId: string, userSelectable: boolean): void;
  onSetReasoningEffort(modelBindingId: string, reasoningEffort: string): void;
}) {
  const { t } = useTranslation();
  const rows = agentModelRows(form, modelBindings).map((row) => ({
    ...row,
    label: modelBindingLabel(
      modelBindings.find((binding) => binding.id === row.bindingId) ?? {
        id: row.bindingId,
        model: row.model
      },
      modelBindings
    )
  }));
  const others = rows.filter((row) => !row.isDefault && (editable || row.userSelectable));
  const effortSelect = (bindingId: string, label: string) => (
    <Select
      size="sm"
      aria-label={`${label}: ${t("configReasoningEffort")}`}
      value={agentModelReasoningEffort(form, bindingId)}
      disabled={!editable}
      onChange={(event) => onSetReasoningEffort(bindingId, event.target.value)}
    >
      <option value="">{t("configModelDefault")}</option>
      {reasoningEfforts.map((effort) => (
        <option key={effort} value={effort}>
          {reasoningEffortLabel(effort, t)}
        </option>
      ))}
    </Select>
  );

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t("build.defaultModel")}
          hint={setByModelManagers ? t("build.modelSetByModelManagers") : undefined}
        >
          <Select
            value={form.modelBindingId}
            disabled={!editable}
            onChange={(event) => onSelectDefault(event.target.value)}
          >
            <option value="">{t("configInstanceDefault")}</option>
            {rows.map((row) => (
              <option key={row.bindingId} value={row.bindingId}>
                {row.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("configReasoningEffort")} hint={t("build.reasoningEffortHint")}>
          {effortSelect(form.modelBindingId, t("build.defaultModel"))}
        </Field>
      </div>
      {others.length > 0 ? (
        <fieldset className="grid min-w-0 gap-2">
          <legend className="pb-2 text-label">{t("build.selectableModels")}</legend>
          {others.map((row) => (
            <div
              key={row.bindingId}
              data-model-binding={row.bindingId}
              className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1"
            >
              <Checkbox
                checked={row.userSelectable}
                disabled={!editable}
                label={row.label}
                onCheckedChange={(checked) => onSetUserSelectable(row.bindingId, checked)}
              />
              {row.userSelectable ? (
                <div className="w-40 shrink-0">{effortSelect(row.bindingId, row.label)}</div>
              ) : null}
            </div>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

export function modelBindingLabel(
  binding: { id: string; model: string; label?: string },
  bindings: readonly { id: string; model: string }[]
): string {
  const duplicateModel = bindings.some(
    (candidate) => candidate.id !== binding.id && candidate.model === binding.model
  );
  const label = modelDisplayLabel(binding);
  return duplicateModel ? `${label} (${binding.id})` : label;
}
