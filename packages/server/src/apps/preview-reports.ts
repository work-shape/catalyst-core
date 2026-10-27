import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  PREVIEW_REPORT_KEEP_MS,
  asConversationId,
  boundPreviewReport,
  isFileSetId,
  type ActorAccess,
  type AuthenticatedUser,
  type ConversationId,
  type FileSetId,
  type PreviewReport,
  type StoredPreviewReport
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import type { ResolvedChatServerOptions } from "../types";
import type { AppActionCalls, FrameSession, FrameSessionProof } from "./action-call";

// What a preview reports of itself (PREVIEW-STATUS-1), kept for the agent of the conversation
// the preview belongs to. A report is diagnostics written in the person's browser by a page an
// agent wrote, so it is read as data of unknown shape: its shape was checked by the route, and
// it is scrubbed and bounded here again, whatever the browser did. It is not a governance
// event: no audit event, log line or Operation Run holds one, and nothing here logs it.

/** How a report is asked to be kept: the frame's proof, and the conversation of a draft. */
export interface PreviewReportInput extends FrameSessionProof {
  conversationId?: string | undefined;
  report: PreviewReport;
}

export class PreviewReports {
  private readonly options: ResolvedChatServerOptions;
  private readonly actions: AppActionCalls;
  private readonly conversations: ConversationWorkflow;
  private readonly now: () => Date;

  constructor(
    options: ResolvedChatServerOptions,
    actions: AppActionCalls,
    now: () => Date = () => new Date()
  ) {
    this.options = options;
    this.actions = actions;
    this.conversations = new ConversationWorkflow(options);
    this.now = now;
  }

  /**
   * Keeps the report of the frame the proof names, for the signed-in caller it was minted for.
   * A Page of a conversation reports into that conversation. The draft of an App reports into
   * the conversation the interface names, when the caller reads it and it is about this App. A
   * published App, and a draft without such a conversation, report nowhere.
   */
  async report(
    caller: { user: AuthenticatedUser; access: ActorAccess },
    input: PreviewReportInput
  ): Promise<{ stored: boolean }> {
    const session = await this.actions.session(caller, input);
    const conversationId = await this.conversationOf(session, caller.user, input.conversationId);
    // The session refused a proof whose file set id is malformed; this says so to the types.
    if (conversationId === undefined || !isFileSetId(input.fileSetId)) {
      return { stored: false };
    }
    const stored = await this.options.stores.pages.putPreviewReport({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      fileSetId: input.fileSetId,
      report: keptReport(input.report, session.usesKit),
      reportedAt: this.now().toISOString()
    });
    return { stored };
  }

  /** The report of one file set in one conversation, while it is younger than 24 hours. */
  read(
    conversationId: ConversationId,
    fileSetId: FileSetId
  ): Promise<StoredPreviewReport | undefined> {
    return this.options.stores.pages.getPreviewReport({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      fileSetId,
      notBefore: new Date(this.now().getTime() - PREVIEW_REPORT_KEEP_MS).toISOString()
    });
  }

  private async conversationOf(
    session: FrameSession,
    user: AuthenticatedUser,
    named: string | undefined
  ): Promise<ConversationId | undefined> {
    if (session.mode === "page") {
      // The session checked that the caller reads it. A name the interface sent does not count.
      return session.conversationId;
    }
    if (session.mode !== "draft" || named === undefined || session.appName === undefined) {
      return undefined;
    }
    const conversation = await this.conversations
      .requireConversationAccess(asConversationId(named), user)
      .catch(() => undefined);
    const subject = conversation?.subject;
    return conversation && subject?.kind === APP_ASSET_KIND && subject.name === session.appName
      ? conversation.id
      : undefined;
  }
}

/**
 * The report as it is kept: scrubbed and bounded again, and a folder whose build recorded that
 * it does not use the kit reads "no bridge used" rather than a bridge that never connected.
 */
function keptReport(report: PreviewReport, usesKit: boolean | undefined): PreviewReport {
  const bounded = boundPreviewReport(report);
  return usesKit === false ? { ...bounded, bridge: "not_used" } : bounded;
}
