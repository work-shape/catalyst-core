import {
  PLATFORM_EVENT_ALLOW,
  isAppError,
  asCollaborationWorkspaceId,
  operationDenialError,
  type GuardrailAnswer,
  type OperationBeforeEvent,
  type Page,
  type PlatformEventAnswer,
  type PlatformEventEmitter,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { guardrailDenial, type AppSaved } from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import type { AssetWorkflowOptions } from "../types";
import type { PageApps } from "./page-apps";

// What a later `app.save` answers about the App draft it writes. The guardrails on asset writes
// are asked about the draft when the save writes it, from the revision the preview shows.

/**
 * The guardrails on asset writes asked about the App draft a later save writes from the
 * revision the preview shows, as they answer a person's write of the App: the event to write
 * with and the warnings the agent passes on, or why the draft is not written.
 *
 * A `require_approval` there is a block, kept as a block hit. Nothing can wait for an
 * approval: the save's own before-events ask nothing about a draft it writes, so no call is
 * left to hold and no request is filed. A hit that asked for an approval nobody can give would
 * count a hold that never was. The person's Save to draft in the preview (`apps.update_from_page`)
 * writes the same draft and waits for the approval there.
 */
export async function askAboutDraft(
  events: PlatformEventEmitter | undefined,
  context: ToolExecutionContext,
  pageApps: Pick<PageApps, "writeEvent">,
  input: { app: string; workspaceId: string; fileSetId?: string | undefined; page: Page }
): Promise<{ event: OperationBeforeEvent; warnings: string[] } | { refusal: string }> {
  const event = pageApps.writeEvent({ ...input, page: () => Promise.resolve(input.page) });
  const answer = await askBeforeWrite(events, context, event, input.workspaceId);
  if (answer.outcome === "block" || answer.outcome === "require_approval") {
    return { refusal: draftGuardrailRefusal(answer, event) };
  }
  return {
    event,
    warnings: answer.guardrails.flatMap((guardrail) =>
      guardrail.outcome === "warn" ? [draftGuardrailWarning(guardrail, event)] : []
    )
  };
}

/**
 * What the guardrails on asset writes answer about a write a tool's call makes after its own
 * before-events were asked, as the agent that acts for the person. Nothing to ask without
 * the events of a call path.
 */
async function askBeforeWrite(
  events: PlatformEventEmitter | undefined,
  context: ToolExecutionContext,
  event: OperationBeforeEvent,
  workspaceId: string
): Promise<PlatformEventAnswer> {
  const request = context.toolRequest;
  if (!events || !request) return PLATFORM_EVENT_ALLOW;
  const runId = context.operationRun?.id;
  return events.emit(
    event.name,
    { ...(runId ? { operationRunId: runId } : {}), subjectKind: event.subject.kind },
    {
      actor: context.user,
      origin: {
        kind: "agent",
        agentRunId: request.agentRunId,
        conversationId: request.conversationId,
        agentName: request.agentName,
        toolCallId: request.toolCallId,
        toolName: request.toolName
      },
      workspaceId: asCollaborationWorkspaceId(workspaceId),
      correlationId: context.correlationId,
      subject: event.subject,
      phase: "before",
      checkable: event.checkable,
      filterBy: { kind: event.subject.kind },
      runtime: {
        ...(context.deadline ? { deadline: context.deadline } : {}),
        ...(context.signal ? { signal: context.signal } : {})
      },
      cannotWait: true
    }
  );
}

/**
 * Why a guardrail left the App's draft unwritten, in the words of its refusal. Where it asked
 * for an approval, which this write cannot wait for, it says where the write can wait.
 */
function draftGuardrailRefusal(answer: PlatformEventAnswer, event: OperationBeforeEvent): string {
  // A guardrail that blocks outright is named before one that asked for an approval.
  const guardrails = [...answer.guardrails].sort(
    (left, right) =>
      Number(left.approvalCannotWait ?? false) - Number(right.approvalCannotWait ?? false)
  );
  const why = operationDenialError(
    guardrailDenial([{ ...answer, guardrails, subject: event.subject }], event.name)
  ).message;
  const asksForApproval = answer.guardrails.some(
    (guardrail) => guardrail.outcome === "block" && guardrail.approvalCannotWait
  );
  const blocked = answer.guardrails.some(
    (guardrail) => guardrail.outcome === "block" && !guardrail.approvalCannotWait
  );
  // The refusal ends in the guardrail's reason, which may end a sentence of its own.
  const first = /[.!?…]$/u.test(why) ? why : `${why}.`;
  return asksForApproval && !blocked
    ? `${first} It asks for another person's approval, which app.save cannot wait for. The App's draft was not written. Ask the person to use Save to draft in the preview, where the write can wait for the approval.`
    : `${first} The App's draft was not written.`;
}

/** A guardrail's warning about the App's draft, which the agent passes on to the person. */
function draftGuardrailWarning(guardrail: GuardrailAnswer, event: OperationBeforeEvent): string {
  const about = event.subject.name ? ` ${event.subject.kind} '${event.subject.name}'` : "";
  const reason = guardrail.reason === "" ? " but could not check it" : `: ${guardrail.reason}`;
  return `Guardrail '${guardrail.displayName}' warned about${about}${reason}`;
}

/** What a save answers about its App, where the App's draft was not written. */
export const draftNotWritten = (
  app: { name: string; title: string },
  message: string
): AppSaved => ({
  kind: "app",
  ...app,
  saved: false,
  message
});

const DRAFT_CHANGED_ELSEWHERE =
  "The App's draft was changed elsewhere since this folder last wrote it, so this save did not write over it. Tell the person: Save to draft in the preview replaces the draft with what the preview shows.";
export const DRAFT_OF_OTHER_FOLDER =
  "This folder never wrote or checked out this App, so this save did not change it. Call app.edit to load the current draft into this conversation, then change and save the returned path.";

const issueMessagesSchema = z.object({ issues: z.array(z.object({ message: z.string() })) });

/**
 * A refusal of the App's own checks with what they found, such as an action on an operation the
 * Connection does not accept. The message of the refusal alone names no issue.
 */
function validationRefusal(message: string, details: unknown): string {
  const read = issueMessagesSchema.safeParse(details);
  const found = read.success ? read.data.issues.map((issue) => issue.message) : [];
  return found.length > 0
    ? `The App's draft was not written. Fix this, open the folder and save it again: ${found.join(" ")}`
    : message;
}

/**
 * Why a write of the App's draft from the preview's revision did not happen, in words the agent
 * may pass on. A refusal of the App's own checks says what it found; whatever else failed is named
 * by its kind only, and logged without content.
 */
export function draftRefusal(error: unknown, logger: AssetWorkflowOptions["logger"]): string {
  if (isAppError(error)) {
    if (error.code === "REVISION_CONFLICT") return DRAFT_CHANGED_ELSEWHERE;
    if (error.code === "FORBIDDEN") {
      return "The person may not write this App, so its draft was not written.";
    }
    if (error.code === "VALIDATION_FAILED") return validationRefusal(error.message, error.details);
    if (error.code === "TIMEOUT") {
      return "Writing the App's draft took too long, so it was not written. Save it again in a moment.";
    }
  } else {
    logger.error(
      { error: error instanceof Error ? error.message : "" },
      "The draft of an App could not be written from its preview"
    );
  }
  return "The App's draft could not be written right now. Save it again in a moment; if it fails again, tell the person to use Save to draft in the preview.";
}
