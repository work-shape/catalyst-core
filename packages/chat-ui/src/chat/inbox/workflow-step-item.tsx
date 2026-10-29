import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import { RouteLink } from "../../studio/route-link";
import { useTranslation } from "../../shared/i18n";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";

// A Workflow step that waits for a person (kind `workflow_step`, the `approval` step): which
// Workflow and run it belongs to, the step, what the step asks, and the inputs it received.
// The decider approves or rejects it; the run goes on with the decision as the step's output.
// The server files it with this preview; the item shows nothing else of the run.

/** One input the step received, as the server shows it: a key and its value in words. */
interface WorkflowStepInput {
  key: string;
  value: string;
}

export interface WorkflowStepPreview {
  workspaceId: string;
  workflow: { id: string; title: string };
  runId: string;
  step: { key: string; title: string };
  /** What the step asks of the person, as its author wrote it. */
  instruction: string;
  inputs: WorkflowStepInput[];
}

/** The step of an item's preview, or nothing where the preview is not one. */
export function parseWorkflowStepPreview(preview: unknown): WorkflowStepPreview | undefined {
  if (
    !isRecord(preview) ||
    typeof preview.workspaceId !== "string" ||
    typeof preview.runId !== "string" ||
    typeof preview.instruction !== "string"
  ) {
    return undefined;
  }
  const workflow = named(preview.workflow, "id");
  const step = named(preview.step, "key");
  if (!workflow || !step) return undefined;
  const inputs = Array.isArray(preview.inputs)
    ? preview.inputs.flatMap((input): WorkflowStepInput[] =>
        isRecord(input) && typeof input.key === "string" && typeof input.value === "string"
          ? [{ key: input.key, value: input.value }]
          : []
      )
    : [];
  return {
    workspaceId: preview.workspaceId,
    workflow: { id: workflow.id, title: workflow.title },
    runId: preview.runId,
    step: { key: step.id, title: step.title },
    instruction: preview.instruction,
    inputs
  };
}

/** An id under `idKey` and a title, falling back to the id where the title is empty. */
function named(value: unknown, idKey: string): { id: string; title: string } | undefined {
  if (!isRecord(value)) return undefined;
  const id = value[idKey];
  if (typeof id !== "string" || id === "") return undefined;
  const title = typeof value.title === "string" && value.title.trim() ? value.title : id;
  return { id, title };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function WorkflowStepBody({ item }: { item: ApprovalRequestView }) {
  const { t } = useTranslation();
  const host = useApprovalRevisionHost();
  const step = parseWorkflowStepPreview(item.preview);
  if (!step) {
    return null;
  }
  return (
    <div className="grid min-w-0 gap-4" data-testid="inbox-workflow-step">
      <KeyValueList>
        <KeyValue label={t("inbox.workflowStepWorkflow")}>{step.workflow.title}</KeyValue>
        <KeyValue label={t("inbox.workflowStepStep")}>{step.step.title}</KeyValue>
        <KeyValue label={t("inbox.workflowStepRun")}>
          <RouteLink
            route={{
              kind: "workflow-run",
              collaborationWorkspaceId: step.workspaceId,
              workflow: step.workflow.id,
              run: step.runId
            }}
            variant="link"
            className="h-auto px-0"
            onOpen={(route) => host?.openRoute?.(route)}
          >
            {t("inbox.noticeOpenRun")}
          </RouteLink>
        </KeyValue>
      </KeyValueList>
      <p className="min-w-0 whitespace-pre-wrap break-words">{step.instruction}</p>
      {step.inputs.length > 0 ? (
        <section className="grid min-w-0 gap-2">
          <h4 className="text-label">{t("inbox.workflowStepInputs")}</h4>
          <KeyValueList>
            {step.inputs.map((input) => (
              <KeyValue key={input.key} label={input.key} foldable>
                <span className="whitespace-pre-wrap break-words">{input.value}</span>
              </KeyValue>
            ))}
          </KeyValueList>
        </section>
      ) : null}
      {item.status === "pending" ? (
        <p className="text-sm text-muted-foreground">{t("inbox.workflowStepWaits")}</p>
      ) : null}
    </div>
  );
}
