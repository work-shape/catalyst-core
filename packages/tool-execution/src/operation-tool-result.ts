import {
  CONNECTION_SIGN_IN_NEEDS,
  INTERNAL_ERROR_MESSAGE,
  type ConnectionSignInNeed,
  INTERRUPTED_RUN_ERROR,
  type ToolExecutionResult,
  type ToolHandlerFailureResult
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { previewToolResult } from "./agent-preview";
import type { OperationOutcome } from "./operation-execution";
import { denialText, type ToolCallNames } from "./tool-refusal-text";
import { failed } from "./tool-results";

/**
 * Projects what a call came to back to the agent that made it as a tool call. A tool that ran
 * answers its own result unchanged. A call that was refused, held or cut off before the tool
 * ran answers in the words an agent has always read for it.
 */
export function toolResultFromOperationResult(
  outcome: Pick<OperationOutcome, "result" | "toolResult"> & {
    /** The run as stored, which says whether a call that continues has ended already. */
    run?: Pick<OperationOutcome["run"], "status" | "error">;
  },
  names: ToolCallNames
): ToolExecutionResult {
  if (outcome.toolResult) return outcome.toolResult;
  const { result } = outcome;
  switch (result.status) {
    case "done":
      return {
        status: "success",
        output: result.output,
        ...(result.display ? { display: result.display } : {}),
        ...(result.structuredResult ? { structuredResult: result.structuredResult } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {})
      };
    case "running": {
      // The operation's work goes on after the call; its run says when it ended. An operation
      // that finished at once has ended it already, and the answer says so, as the API's does.
      const { run } = outcome;
      if (run?.status === "done")
        return { status: "success", output: { status: "done", operationRunId: result.runId } };
      if (run?.status === "failed" && run.error)
        return toolResultFromOperationResult(
          {
            result: {
              status: "failed",
              runId: result.runId,
              error: {
                code: run.error.code,
                message: run.error.message,
                ...(run.error.reason ? { details: { reason: run.error.reason } } : {})
              }
            }
          },
          names
        );
      return { status: "success", output: { status: "running", operationRunId: result.runId } };
    }
    case "denied":
      if (names.useRightRefusal) return failed("permission_missing", names.useRightRefusal);
      return result.reason.kind === "policy" && result.reason.reason === "confirmation_required"
        ? failed("confirmation_required", denialText(result.reason, names), {
            operation: result.reason.operation
          })
        : failed("not_allowed", denialText(result.reason, names));
    case "failed":
      // The error envelope replaces an unexposed message with this fixed text. An exposed
      // timeout message is the handler's answer and must reach the agent unchanged.
      if (result.error.code === "TIMEOUT" && result.error.message === INTERNAL_ERROR_MESSAGE)
        return toolTimeoutFailure(names);
      return (
        personalSignInFailure(result.error.details, names) ??
        (result.error.code === "INTERNAL"
          ? internalFailure(names.correlationId)
          : // The message is all the model reads. A fixed reason stays in the run and in the
            // details of the result, and is not handed on: a model repeats a code to the person.
            {
              ...failed(
                "handler_failed",
                result.error.code === INTERRUPTED_RUN_ERROR.code
                  ? `${INTERRUPTED_RUN_ERROR.message}. Its outcome is not known; check before calling again.`
                  : result.error.message
              ),
              ...privateConversationRecovery(result.error.details)
            })
      );
    case "expired":
    case "pending_confirmation":
    case "pending_approval":
      return internalFailure(names.correlationId);
    case "dry_run":
      return previewToolResult(result, names.locale);
  }
}

/** Only this fixed recovery reaches the host; arbitrary server reasons stay private. */
export function privateConversationRecovery(
  details: unknown
): Pick<ToolHandlerFailureResult, "recovery"> {
  const parsed = z.object({ reason: z.literal("subject_conversation_shared") }).safeParse(details);
  return parsed.success ? { recovery: "private_conversation" } : {};
}

const personalRefusalSchema = z.object({
  reason: z.enum(["connection_not_connected", "connection_needs_reconnect"]),
  state: z.enum(CONNECTION_SIGN_IN_NEEDS),
  connection: z.object({
    name: z.string().min(1),
    title: z.string(),
    service: z.string().optional(),
    catalogue: z.object({ entry: z.string(), part: z.string() }).optional()
  })
});

/**
 * A call of a personal Connection refused because the person has not signed in, or the
 * outside system refused their sign-in (CS-9a). The agent reads the refusal's own code and one
 * plain sentence: the person connects from the card in the chat and says when they have. The
 * host reads the Connection's name, title, service and catalogue link, and the agent whose call
 * it was, for that card; the refusal names no account and no token.
 */
export function personalSignInFailure(
  details: unknown,
  names: Pick<ToolCallNames, "agentName" | "locale">
): ToolHandlerFailureResult | undefined {
  const parsed = personalRefusalSchema.safeParse(details);
  if (!parsed.success) return undefined;
  const { connection, state, reason } = parsed.data;
  const title = connection.title || connection.name;
  return {
    ...failed(reason, signInSentence(title, state, names.locale)),
    connect: {
      connection: {
        name: connection.name,
        title,
        ...(connection.service === undefined ? {} : { service: connection.service }),
        ...(connection.catalogue === undefined
          ? {}
          : { catalogue: { entry: connection.catalogue.entry, part: connection.catalogue.part } })
      },
      state,
      agentName: names.agentName
    }
  };
}

function signInSentence(
  title: string,
  state: ConnectionSignInNeed,
  locale: ToolCallNames["locale"]
): string {
  if (locale === "de") {
    return state === "needs_reconnect"
      ? `Die Anmeldung der Person bei ${title} ist abgelaufen. Sie sieht in diesem Chat eine Karte, um sich neu anzumelden. Warte, bis sie sagt, dass ${title} verbunden ist; wiederhole diesen Fehler nicht.`
      : `Die Person hat ${title} noch nicht verbunden. Sie sieht in diesem Chat eine Karte zum Verbinden. Warte, bis sie sagt, dass ${title} verbunden ist; wiederhole diesen Fehler nicht.`;
  }
  return state === "needs_reconnect"
    ? `The person's sign-in to ${title} has ended. They see a card in this chat to sign in again. Wait until they say ${title} is connected; do not repeat this error.`
    : `The person has not connected ${title} yet. They see a Connect card in this chat. Wait until they say ${title} is connected; do not repeat this error.`;
}

export function internalFailure(correlationId: string): ToolHandlerFailureResult {
  return failed(
    "handler_failed",
    `The tool failed with an internal error. Reference: ${correlationId}`,
    { correlationId }
  );
}

/** A timeout says nothing about whether an unacknowledged change happened. */
export function toolTimeoutFailure(
  names: Pick<ToolCallNames, "toolName" | "locale">
): ToolHandlerFailureResult {
  return {
    status: "timed_out",
    error: {
      code: "timed_out",
      message:
        names.locale === "de"
          ? `Das Tool '${names.toolName}' hat nicht rechtzeitig geantwortet. Das Ergebnis ist unbekannt; vor einem erneuten Aufruf prüfen.`
          : `The tool '${names.toolName}' did not answer in time. Its outcome is not known; check before calling again.`
    }
  };
}
