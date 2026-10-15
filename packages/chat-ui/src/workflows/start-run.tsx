import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button, Dialog, Field, InlineError, Input, Select, Switch } from "@work-shape/catalyst-ui";
import { instanceSentence, readRefusalDetails } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import {
  NO_START_FORM,
  checkStartForm,
  initialStartValues,
  startRefusalByField,
  type StartField,
  type StartFieldProblem,
  type StartFieldValue,
  type StartForm,
  type StartRefusalIssue,
  valueOf
} from "./start-form";
import { useWorkflowWrites, workflowWriteRefusal } from "./workflow-data";
import { useWorkflowsHost } from "./workflows-host";

/**
 * What the instance said against a start: a sentence for the whole form, or the values it did
 * not take, which the form puts under their fields.
 */
type StartRefusal = { message: string } | { issues: readonly StartRefusalIssue[] };

/**
 * The start of a Workflow by hand: the question before it, with the form of its inputs where
 * it has any, the start, and the way to the new run. `open` asks; `dialog` is the question
 * while it is asked. `again` words it for a start from the page of an earlier run.
 */
export function useStartRun(input: {
  workflow: string;
  /** The name people read. The question is not asked before it is known. */
  name: string | undefined;
  /** What a start asks for. Without one the start asks for nothing. */
  form?: StartForm;
  again?: boolean;
}): { open(): void; dialog: ReactNode } {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const writes = useWorkflowWrites();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<StartRefusal>();
  const workspaceId = host?.workspace?.id;

  const start = async (runInput: Record<string, unknown>) => {
    setBusy(true);
    setRefusal(undefined);
    try {
      const run = await writes.start(input.workflow, runInput);
      setAsking(false);
      if (workspaceId !== undefined) {
        // Whoever starts a run watches it from its first second.
        host?.showRoute({
          kind: "workflow-run",
          collaborationWorkspaceId: workspaceId,
          workflow: input.workflow,
          run: run.id
        });
      }
    } catch (failure) {
      const refused = workflowWriteRefusal(failure);
      const details = readRefusalDetails(failure);
      setRefusal(
        refused !== undefined
          ? {
              message: t(
                refused === "pending" ? "workflows.start.pending" : "workflows.start.refused"
              )
            }
          : details.reason === "input_invalid"
            ? { issues: details.issues }
            : { message: instanceSentence(failure) ?? t("workflows.start.failed") }
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    open() {
      setRefusal(undefined);
      setAsking(true);
    },
    dialog:
      asking && input.name !== undefined ? (
        <StartDialog
          name={input.name}
          form={input.form}
          again={input.again}
          loading={busy}
          error={refusal !== undefined && "message" in refusal ? refusal.message : undefined}
          refusedValues={refusal !== undefined && "issues" in refusal ? refusal.issues : undefined}
          onConfirm={(runInput) => {
            start(runInput).catch(() => undefined);
          }}
          onClose={() => setAsking(false)}
        />
      ) : null
  };
}

/**
 * Asks once before a Workflow is started by hand, and answers a refused start in place. A
 * Workflow with inputs asks for them here: the start is made only from values the form took.
 */
export function StartDialog({
  name,
  form: given = NO_START_FORM,
  again = false,
  test = false,
  loading,
  error,
  refusedValues,
  onConfirm,
  onClose
}: {
  name: string;
  form?: StartForm;
  /** The start is asked for on the page of an earlier run, which stays as it is. */
  again?: boolean;
  /** The start is a test run of the draft, which acts as the reader and simulates changes. */
  test?: boolean;
  loading: boolean;
  error: string | undefined;
  /**
   * The values the instance did not take although the form did: its inputs changed since the
   * page read them, or it checks what the form does not.
   */
  refusedValues?: readonly StartRefusalIssue[];
  onConfirm(input: Record<string, unknown>): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  // The fields stay those the dialog opened with, also where the Workflow is read again while
  // it is open: what was typed is never moved or dropped. The instance checks the start.
  const [form] = useState(given);
  const [values, setValues] = useState(() => initialStartValues(form));
  const [submitted, setSubmitted] = useState(false);
  // A value changed after the instance refused it is the reader's again, until the next start.
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());
  const asks = form.fields.length > 0;
  const check = checkStartForm(form, values);
  const problems = submitted && !check.ok ? check.problems : undefined;
  const refused =
    refusedValues === undefined ? undefined : startRefusalByField(form, refusedValues);
  const shownError =
    refused === undefined ? error : [t("workflows.startForm.refused"), ...refused.rest].join(" ");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setChanged(new Set());
    if (check.ok) {
      onConfirm(check.input);
    }
  };
  const change = (field: string, value: StartFieldValue) => {
    setValues((current) => ({ ...current, [field]: value }));
    setChanged((current) => new Set(current).add(field));
  };
  const body = t(
    test
      ? "workflows.test.body"
      : again
        ? "workflows.run.againBody"
        : asks
          ? "workflows.startForm.body"
          : "workflows.start.bodyManual"
  );
  return (
    <Dialog
      open
      size={asks ? "md" : "sm"}
      title={t(
        test
          ? "workflows.test.title"
          : again
            ? "workflows.run.againTitle"
            : "workflows.start.title",
        { name }
      )}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={loading} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={loading}>
            {t(test ? "workflows.test.confirm" : "workflows.start.confirm")}
          </Button>
        </>
      }
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        <p className="text-body text-muted-foreground">{body}</p>
        {form.fields.map((field) => (
          <StartFormField
            key={field.name}
            field={field}
            value={valueOf(values, field.name) ?? field.initial}
            problem={problems?.get(field.name)}
            refused={changed.has(field.name) ? undefined : refused?.fields.get(field.name)}
            onChange={(value) => change(field.name, value)}
          />
        ))}
        {shownError ? <InlineError>{shownError}</InlineError> : null}
      </form>
    </Dialog>
  );
}

/** One input of the start form, with its label, its description and what is wrong with it. */
function StartFormField({
  field,
  value,
  problem,
  refused,
  onChange
}: {
  field: StartField;
  value: StartFieldValue;
  problem: StartFieldProblem | undefined;
  refused: string | undefined;
  onChange(value: StartFieldValue): void;
}) {
  const { locale, t } = useTranslation();
  const number = new Intl.NumberFormat(locale);
  const error =
    problem === undefined
      ? refused
      : t(
          problem.key,
          Object.fromEntries(
            Object.entries(problem.values ?? {}).map(([key, limit]) => [key, number.format(limit)])
          )
        );
  const text = typeof value === "string" ? value : "";
  const shared = {
    label: field.label,
    hint: field.hint,
    error,
    required: field.required && field.control !== "yesNo",
    optional: !field.required && field.control !== "yesNo"
  };
  switch (field.control) {
    case "yesNo":
      return (
        <Field {...shared} layout="inline">
          <Switch checked={value === true} onCheckedChange={onChange} />
        </Field>
      );
    case "choice":
      return (
        <Field {...shared}>
          <Select value={text} onChange={(event) => onChange(event.currentTarget.value)}>
            <option value="" disabled={field.required}>
              {t("workflows.startForm.choosePlaceholder")}
            </option>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "number":
      return (
        <Field {...shared}>
          {/* The browser reads the number in the reader's notation and hands it on as one. */}
          <Input
            type="number"
            step={field.integer === true ? 1 : "any"}
            autoComplete="off"
            value={text}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </Field>
      );
    case "date":
    case "email":
    case "text":
      return (
        <Field {...shared}>
          <Input
            type={field.control === "text" ? "text" : field.control}
            autoComplete="off"
            value={text}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </Field>
      );
  }
}
