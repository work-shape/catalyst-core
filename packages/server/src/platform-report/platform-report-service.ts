import type { PlatformReport, SendPlatformReportRequest } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  PLATFORM_REPORTS_PER_HOUR,
  asAgentRunId,
  asConversationId,
  asUserId,
  auditActorFromUser,
  createPlatformReportId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  isPlatformRunFailureCode,
  platformToolFailureReason,
  readToolResultMetadata,
  type AgentRun,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ChatMessage,
  type OperationAuthorization,
  type OperationExecutionContext
} from "@work-shape/catalyst-core";
import { requireConversationAccess } from "../conversations/conversation-access";
import type { ChatServerOptions } from "../types";

// "Problem an Workshape melden" (PLATFORM-REPORT). A person who reads a conversation reports a
// run of it that failed for a platform reason. The server decides from its own records whether
// it did, with the same classification the interface uses: a run failed with a platform code,
// or a `workspace.exec` result that names a platform reason. The mail goes from the instance's
// system sender to the operator's support address. The person's note is in the mail and in
// nothing else: not in the record, the audit, the Operation Run or a log line.

type PlatformReportOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "config" | "mail"
>;

type CallContext = Pick<OperationExecutionContext, "actor" | "origin" | "audit" | "correlationId">;

/** What the Operation Run hashes and keeps of a call with a note: never the note. */
export const PLATFORM_REPORT_NOTE_MARK = "[note]";

/** Whether this instance offers the report: an operator address and platform mail. */
export function platformReportAvailable(
  options: Pick<ChatServerOptions, "config" | "mail">
): boolean {
  return Boolean(options.config.support.email && options.mail);
}

/** Only a person sends a report. */
export function authorizePlatformReport(
  _input: unknown,
  { actor }: { actor: AuthenticatedIdentity }
): OperationAuthorization {
  return isAuthenticatedServicePrincipal(actor)
    ? {
        allowed: false,
        action: "platform_report.send",
        reason: "no_grant",
        message: "Only a person reports a platform problem"
      }
    : { allowed: true };
}

/** The platform failure of a run, as its records say: the code, the time and the command. */
interface RunPlatformFailure {
  errorCode: string;
  failedAt: string;
  commandId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The platform failure of a run, or nothing where it failed for no platform reason. The run's
 * own error comes first; else the first tool result of the run that names a platform reason.
 */
function runPlatformFailure(
  run: Pick<AgentRun, "id" | "status" | "error" | "failedAt" | "updatedAt">,
  messages: readonly Pick<ChatMessage, "metadata" | "createdAt">[]
): RunPlatformFailure | undefined {
  const runCode = run.status === "failed" ? run.error?.code : undefined;
  if (runCode !== undefined && isPlatformRunFailureCode(runCode)) {
    return { errorCode: runCode, failedAt: run.failedAt ?? run.updatedAt };
  }
  for (const message of messages) {
    const result = readToolResultMetadata(message.metadata);
    if (!result || result.runId !== run.id || !isRecord(result.result)) continue;
    if (result.result.status === "success") continue;
    const reason = platformToolFailureReason(result.result.error);
    if (!reason) continue;
    const details = isRecord(result.result.error) ? result.result.error.details : undefined;
    const commandId =
      isRecord(details) && typeof details.commandId === "string" ? details.commandId : undefined;
    const at = isRecord(details) && typeof details.at === "string" ? details.at : undefined;
    return {
      errorCode: reason,
      failedAt: at ?? message.createdAt,
      ...(commandId ? { commandId } : {})
    };
  }
  return undefined;
}

function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Only a person reports a platform problem");
  }
  return actor;
}

export class PlatformReportWorkflow {
  constructor(private readonly options: PlatformReportOptions) {}

  async send(
    context: CallContext,
    conversationId: string,
    runId: string,
    input: SendPlatformReportRequest
  ): Promise<PlatformReport> {
    const user = personOf(context.actor);
    // Only the person at the interface: an agent, a key or a Workflow writes no mail to the
    // operator in their name.
    if (context.origin.kind !== "user") {
      throw new AppError("FORBIDDEN", "A platform problem is reported in the interface", {
        reason: "interface_only"
      });
    }
    const { stores, clientInstanceId, mail } = this.options;
    const supportEmail = this.options.config.support.email;
    if (!supportEmail || !mail) {
      throw new AppError("NOT_FOUND", "This instance takes no platform problem reports", {
        reason: "platform_report_unavailable"
      });
    }
    const conversation = await requireConversationAccess(
      this.options,
      asConversationId(conversationId),
      user
    );
    const run = await stores.agentRuns.getConversationAgentRun({
      clientInstanceId,
      conversationId: conversation.id,
      runId: asAgentRunId(runId)
    });
    if (!run) throw new AppError("NOT_FOUND", "The run was not found");
    const failure = runPlatformFailure(
      run,
      run.status === "failed" && isPlatformRunFailureCode(run.error?.code)
        ? []
        : await stores.conversations.listMessages({
            clientInstanceId,
            conversationId: conversation.id
          })
    );
    if (!failure) {
      throw new AppError("CONFLICT", "The run did not fail for a platform reason", {
        reason: "not_a_platform_failure"
      });
    }
    const replyTo = input.replyToMe ? await this.replyAddress(user) : undefined;
    const reportedAt = new Date().toISOString();
    const authorUserId = getSubjectUserId(user);
    const created = await stores.platformReports.createPlatformReport({
      id: createPlatformReportId(),
      clientInstanceId,
      agentRunId: run.id,
      authorUserId,
      errorCode: failure.errorCode,
      createdAt: reportedAt,
      perHour: PLATFORM_REPORTS_PER_HOUR
    });
    if (created.status === "duplicate") {
      throw new AppError("CONFLICT", "You reported this problem already", {
        reason: "already_reported"
      });
    }
    if (created.status === "limited") {
      throw new AppError("RATE_LIMITED", "You sent several reports in the last hour", {
        reason: "platform_reports_per_hour",
        retryAfterSeconds: 3600
      });
    }
    const report = created.record;
    const note = input.note?.trim();
    const result = await mail.sender.send({
      template: "platform-report",
      to: { email: supportEmail },
      ...(replyTo ? { replyTo } : {}),
      locale: this.options.config.localization.defaultLocale,
      params: {
        instance: {
          id: this.options.config.clientInstance.id,
          displayName: this.options.config.clientInstance.displayName,
          environment: this.options.config.clientInstance.environment,
          appUrl: mail.appUrl
        },
        runId: run.id,
        ...(failure.commandId ? { commandId: failure.commandId } : {}),
        errorCode: failure.errorCode,
        failedAt: failure.failedAt,
        reportedAt,
        ...(note ? { note } : {})
      }
    });
    await context.audit.record({
      type: "agent_run.platform_reported",
      status: result.ok ? "success" : "failed",
      actor: auditActorFromUser(user),
      subject: run.id,
      correlationId: context.correlationId,
      metadata: { reportId: report.id, errorCode: failure.errorCode }
    });
    if (!result.ok) {
      // A mail that may have left counts as sent; one that surely did not may be sent again.
      const left = result.failure === "uncertain";
      if (!left) {
        await stores.platformReports.deletePlatformReport({ clientInstanceId, id: report.id });
      }
      throw new AppError(
        "INTERNAL",
        "The report could not be sent",
        { reason: "mail_failed" },
        { exposeMessage: true, changedNothing: !left }
      );
    }
    return { id: report.id, reportedAt };
  }

  /** The person's own address, for replies; refused where their account has none. */
  private async replyAddress(user: AuthenticatedUser) {
    const record = await this.options.stores.users.getUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user))
    });
    if (!record?.email) {
      throw new AppError("VALIDATION_FAILED", "Your account has no email address for an answer", {
        reason: "no_reply_address"
      });
    }
    return { email: record.email, displayLabel: record.displayLabel };
  }
}
