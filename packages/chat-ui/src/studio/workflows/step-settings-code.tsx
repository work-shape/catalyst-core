import type { ReactNode } from "react";
import { Field, KeyValue, KeyValueList, Textarea } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { SCRIPT_FIELD, stepValue } from "./step-edits";
import { StepInputsAndAnswers } from "./step-settings-agent";
import type { KindProps } from "./step-settings-parts";

// The Settings of a script (workflow-canvas 9.4, WF-EDIT-2): the script itself, what it gets
// and what it answers with. The script is the file the step names in the Workflow's folder;
// the form writes the file and never shows its path. The language was chosen when the step
// was added; the packages are the agent's to change.

const LANGUAGES: Readonly<Record<string, string>> = {
  py: "Python",
  js: "JavaScript",
  mjs: "JavaScript",
  ts: "TypeScript"
};

function languageOf(file: unknown): string | undefined {
  if (typeof file !== "string") return undefined;
  const ending = /\.([A-Za-z0-9]+)$/u.exec(file)?.[1]?.toLowerCase();
  return ending === undefined ? undefined : LANGUAGES[ending];
}

/** The Settings of a script step. */
export function CodeSettings(props: KindProps & { changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const { step, stepId, editing, issue, under, set } = props;
  const script = stepValue(editing.manifest, editing.files, stepId, SCRIPT_FIELD);
  const language = languageOf(step.file);
  const packages = Array.isArray(step.packages)
    ? step.packages.filter((name) => typeof name === "string")
    : [];
  return (
    <>
      {language === undefined && packages.length === 0 ? null : (
        <KeyValueList>
          {language === undefined ? null : (
            <KeyValue label={t("workflows.settings.language")}>{language}</KeyValue>
          )}
          {packages.length === 0 ? null : (
            <KeyValue label={t("workflows.settings.packages")}>{packages.join(", ")}</KeyValue>
          )}
        </KeyValueList>
      )}
      <div className="grid gap-2">
        <Field label={t("workflows.settings.script")} error={issue("file")}>
          <Textarea
            variant="code"
            rows={12}
            spellCheck={false}
            value={typeof script === "string" ? script : ""}
            onChange={(event) => set({ [SCRIPT_FIELD]: event.target.value })}
            onBlur={editing.validate}
          />
        </Field>
        {under(SCRIPT_FIELD)}
      </div>
      <StepInputsAndAnswers {...props} />
    </>
  );
}
