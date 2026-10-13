import { useMemo, useState } from "react";
import type { AppAction } from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  CodeBlock,
  Dialog,
  Field,
  InlineError,
  KeyValue,
  KeyValueList,
  Spinner,
  Textarea
} from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useTranslation } from "../i18n";
import { operationStatusLabelKeys } from "../operations/operations-model";
import { useFrameCallTexts } from "../pages/frame-call-texts";
import { createFrameCalls } from "../pages/frame-calls";
import { AppActionTarget } from "./app-action-facts";
import {
  appActionInputStart,
  appActionParameterTypeKeys,
  appActionTestOutcome,
  appActionTestTones,
  formatAppActionResult,
  keptWhileItServes,
  readAppActionInput,
  type AppActionInputProblem,
  type AppActionTestOutcome
} from "./app-actions-model";
import { useAppsHost, type AppsHost } from "./apps-host";

/**
 * The test of one reading action of a draft. It is the call a tile of the draft makes: the
 * dialog asks for the address of the draft's frame and calls the action through it, with the
 * builder's own session. So the right on the App, the right on the Connection and the policy
 * are asked where every call asks them, and the call leaves its Operation Run.
 */
export function ActionTestDialog({
  app,
  action,
  onClose
}: {
  app: string;
  action: AppAction;
  onClose(): void;
}) {
  const { client } = useWorkspaceApiClient();
  const texts = useFrameCallTexts();
  const host = useAppsHost();
  const [text, setText] = useState(() => appActionInputStart(action.inputSchema));
  const [problem, setProblem] = useState<AppActionInputProblem>();
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<AppActionTestOutcome>();
  // The frame of this dialog: one address for the tests made while it serves.
  const frame = useMemo(
    () =>
      keptWhileItServes(async () =>
        createFrameCalls(
          client,
          await client.apps.preview({ params: { app }, body: { mode: "draft" } }),
          texts
        )
      ),
    [client, app, texts]
  );

  const test = async () => {
    const read = readAppActionInput(text, action.inputSchema);
    setProblem(read.ok ? undefined : read.problem);
    if (!read.ok) {
      return;
    }
    setWorking(true);
    try {
      const calls = await frame();
      setOutcome(
        calls
          ? appActionTestOutcome(
              await calls.run({ type: "action", name: action.name, input: read.input })
            )
          : { status: "failed" }
      );
    } catch {
      // The address of the draft could not be had: nothing was called.
      setOutcome({ status: "failed" });
    } finally {
      setWorking(false);
    }
  };

  return (
    <ActionTestDialogView
      action={action}
      text={text}
      problem={problem}
      working={working}
      outcome={outcome}
      operations={host?.operations}
      onTextChange={(next) => {
        setText(next);
        setProblem(undefined);
      }}
      onTest={() => {
        // Every way a test ends is shown as its outcome, so nothing is left to catch.
        test().catch(() => undefined);
      }}
      onClose={onClose}
    />
  );
}

/** The test dialog for given facts: the input, and under it how the last call ended. */
export function ActionTestDialogView({
  action,
  text,
  problem,
  working,
  outcome,
  operations,
  onTextChange,
  onTest,
  onClose
}: {
  action: AppAction;
  text: string;
  /** What the input cannot be sent for. Shown at the input, before any call. */
  problem: AppActionInputProblem | undefined;
  working: boolean;
  outcome: AppActionTestOutcome | undefined;
  /** Where runs are read, for a reader who may open that place. */
  operations?: AppsHost["operations"];
  onTextChange(text: string): void;
  onTest(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  // A refusal does not change by asking again, so the way out leads and the test steps back.
  const refused = !working && outcome?.status === "denied";
  return (
    <Dialog
      open
      size="lg"
      title={t("apps.actionTestTitle", { name: action.name })}
      description={
        // A draft starts no Workflow: its test asks the rights and the input, and lists no run.
        action.kind === "workflow" ? (
          t("apps.actionTestBodyWorkflow")
        ) : (
          <>
            {t("apps.actionTestBody")}{" "}
            {operations ? (
              <Button asChild variant="link" size="sm" className="h-auto px-0 align-baseline">
                <a href={operations.href} data-app-action-test-operations>
                  {t("apps.actionTestListed")}
                </a>
              </Button>
            ) : (
              t("apps.actionTestListed")
            )}
          </>
        )
      }
      onClose={onClose}
      footer={
        <>
          <Button variant={refused ? "primary" : "outline"} onClick={onClose}>
            {t("close")}
          </Button>
          <Button variant={refused ? "outline" : "primary"} loading={working} onClick={onTest}>
            {t("apps.actionTest")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4" data-app-action-test={action.name}>
        <KeyValueList>
          <KeyValue label={t("apps.actionCalls")}>
            <AppActionTarget action={action} />
          </KeyValue>
        </KeyValueList>
        <Field
          label={t("apps.actionInput")}
          hint={t("apps.actionInputHint")}
          error={problem ? <InputProblem problem={problem} /> : undefined}
        >
          <Textarea
            variant="code"
            rows={6}
            spellCheck={false}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
          />
        </Field>
        {working ? (
          // The answer of an outside system can take half a minute. What the call before
          // answered is gone meanwhile: it is not the answer to this input.
          <p
            role="status"
            className="flex animate-loading-appear items-center gap-2 text-body text-muted-foreground"
            data-app-action-test-status="running"
          >
            <Spinner size="sm" />
            {t("apps.actionTestRunning")}
          </p>
        ) : outcome ? (
          <TestOutcome outcome={outcome} action={action} runHref={operations?.runHref} />
        ) : null}
      </div>
    </Dialog>
  );
}

function InputProblem({ problem }: { problem: AppActionInputProblem }) {
  const { t } = useTranslation();
  switch (problem.kind) {
    case "not_json":
      return t("apps.actionInputNotJson");
    case "not_object":
      return t("apps.actionInputNotObject");
    case "missing":
      return t("apps.actionInputMissing", { name: problem.name });
    case "unknown":
      return t("apps.actionInputUnknown", { name: problem.name });
    case "wrong_type":
      return t("apps.actionInputWrongType", {
        name: problem.name,
        type: t(appActionParameterTypeKeys[problem.expected])
      });
    case "not_allowed":
      return t("apps.actionInputNotAllowed", { name: problem.name });
  }
}

/** How the last call ended: its status, the way to its run, and what it answered. */
function TestOutcome({
  outcome,
  action,
  runHref
}: {
  outcome: AppActionTestOutcome;
  action: AppAction;
  runHref: ((runId: string) => string) | undefined;
}) {
  const { t } = useTranslation();
  const result =
    outcome.status === "done"
      ? formatAppActionResult(outcome.result)
      : outcome.status === "dry_run"
        ? formatAppActionResult(outcome.input)
        : undefined;
  const href = outcome.runId === undefined ? undefined : runHref?.(outcome.runId);
  return (
    <section
      aria-live="polite"
      className="grid grid-cols-1 gap-3"
      data-app-action-test-status={outcome.status}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Badge tone={appActionTestTones[outcome.status]} dot>
          {t(
            outcome.status === "dry_run"
              ? "apps.actionTestDryRun"
              : operationStatusLabelKeys[outcome.status]
          )}
        </Badge>
        {href ? (
          <Button asChild variant="link" size="sm" className="h-auto px-0">
            <a href={href} data-app-action-test-run>
              {t("apps.actionTestOpenRun")}
            </a>
          </Button>
        ) : null}
      </div>
      {outcome.status === "dry_run" ? (
        <p className="text-body text-muted-foreground">
          {action.kind === "workflow"
            ? t("apps.actionTestDryRunWorkflow", { workflow: action.workflow.name })
            : outcome.message}
        </p>
      ) : null}
      {result ? (
        <div className="grid grid-cols-1 gap-1" data-truncated={result.truncated || undefined}>
          <CodeBlock
            code={result.text}
            label={t(
              outcome.status === "dry_run" ? "apps.actionDryRunInput" : "apps.actionResultOf",
              {
                name: action.name
              }
            )}
            className="max-h-72"
          />
          {result.truncated ? (
            <span className="text-caption text-muted-foreground">
              {t("apps.actionResultTruncated", {
                shown: result.text.length,
                total: result.length
              })}
            </span>
          ) : null}
        </div>
      ) : outcome.status === "pending_approval" ? (
        <p className="text-body text-muted-foreground">{t("apps.actionTestPending")}</p>
      ) : (
        <InlineError>
          {(outcome.status !== "done" && outcome.message) || t("apps.actionTestFailed")}
        </InlineError>
      )}
    </section>
  );
}
