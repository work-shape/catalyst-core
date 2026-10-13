import { useState, type ReactNode } from "react";
import { Button, Dialog, InlineError } from "@vivd-catalyst/ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import { useWorkflowWrites, workflowWriteRefusal } from "./workflow-data";
import { useWorkflowsHost } from "./workflows-host";

/**
 * The start of a Workflow by hand: the question before it, the start, and the way to the new
 * run. `open` asks; `dialog` is the question while it is asked. `again` words it for a start
 * from the page of an earlier run.
 */
export function useStartRun(input: {
  workflow: string;
  /** The name people read. The question is not asked before it is known. */
  name: string | undefined;
  again?: boolean;
}): { open(): void; dialog: ReactNode } {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const writes = useWorkflowWrites();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const workspaceId = host?.workspace?.id;

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const run = await writes.start(input.workflow);
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
      const refusal = workflowWriteRefusal(failure);
      setError(
        refusal === "pending"
          ? t("workflows.start.pending")
          : refusal === "refused"
            ? t("workflows.start.refused")
            : (instanceSentence(failure) ?? t("workflows.start.failed"))
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    open() {
      setError(undefined);
      setAsking(true);
    },
    dialog:
      asking && input.name !== undefined ? (
        <StartDialog
          name={input.name}
          again={input.again}
          loading={busy}
          error={error}
          onConfirm={() => {
            start().catch(() => undefined);
          }}
          onClose={() => setAsking(false)}
        />
      ) : null
  };
}

/** Asks once before a Workflow is started by hand, and answers a refused start in place. */
export function StartDialog({
  name,
  again = false,
  loading,
  error,
  onConfirm,
  onClose
}: {
  name: string;
  /** The start is asked for on the page of an earlier run, which stays as it is. */
  again?: boolean;
  loading: boolean;
  error: string | undefined;
  onConfirm(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      size="sm"
      title={t(again ? "workflows.run.againTitle" : "workflows.start.title", { name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={loading} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button loading={loading} onClick={onConfirm}>
            {t("workflows.start.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-body text-muted-foreground">
        {t(again ? "workflows.run.againBody" : "workflows.start.bodyManual")}
      </p>
      {error ? <InlineError className="mt-3">{error}</InlineError> : null}
    </Dialog>
  );
}
