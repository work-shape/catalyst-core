import {
  asConversationId,
  asUserId,
  boundPreviewReport,
  getSubjectUserId,
  isFileSetId,
  type ActorAccess,
  type AuthenticatedUser,
  type ConversationId,
  type PreviewReport
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import type { ResolvedChatServerOptions } from "../types";
import type { AppActionCalls, FrameSessionProof, ReportingFrame } from "./action-call";
import { previewSourceLocations } from "./preview-source-locations";

// What a preview reports of itself (PREVIEW-STATUS-1), kept for the agent of the conversation
// the preview belongs to, per person whose browser showed it: a run reads only the report of the
// person whose turn it serves, never another member's. A report is diagnostics written in the person's browser by a page an
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
   * A Page of a conversation reports into that conversation. The draft of an App, and the
   * preview of another kind's draft such as a form page, report into the conversation the
   * interface names, when the caller reads it and it is about this asset or created it. A
   * published App, and a draft without such a conversation, report nowhere.
   */
  async report(
    caller: { user: AuthenticatedUser; access: ActorAccess },
    input: PreviewReportInput
  ): Promise<{ stored: boolean }> {
    const frame = await this.actions.reportingFrame(caller, input);
    const conversationId = await frameConversation(
      this.options,
      this.conversations,
      frame,
      caller.user,
      input.conversationId
    );
    // The session refused a proof whose file set id is malformed; this says so to the types.
    if (conversationId === undefined || !isFileSetId(input.fileSetId)) {
      return { stored: false };
    }
    const fileSet = await this.options.stores.pages.getServedFileSet({
      clientInstanceId: this.options.clientInstanceId,
      fileSetId: input.fileSetId
    });
    const bounded = keptReport(input.report, frame.usesKit);
    const report = fileSet ? await previewSourceLocations(this.options, fileSet, bounded) : bounded;
    const stored = await this.options.stores.pages.putPreviewReport({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      fileSetId: input.fileSetId,
      userId: asUserId(getSubjectUserId(caller.user)),
      report,
      reportedAt: this.now().toISOString()
    });
    return { stored };
  }
}


/**
 * The conversation a frame shows a preview of, for the caller. A Page of a conversation belongs
 * to that conversation. A draft, of an App or of another kind such as a form page, belongs to
 * the conversation the interface names, when the caller reads it and it is about that asset or
 * created it. A published App, and a draft without such a conversation, belong to none.
 */
export async function frameConversation(
  options: ResolvedChatServerOptions,
  conversations: ConversationWorkflow,
  frame: ReportingFrame,
  user: AuthenticatedUser,
  named: string | undefined
): Promise<ConversationId | undefined> {
  if (frame.mode === "page") {
    // The frame's check read it for the caller. A name the interface sent does not count.
    return frame.conversationId;
  }
  if (frame.mode !== "draft" || named === undefined || frame.asset.name === "") {
    return undefined;
  }
  const conversation = await conversations
    .requireConversationAccess(asConversationId(named), user)
    .catch(() => undefined);
  if (!conversation) return undefined;
  const { asset } = frame;
  const subject = conversation.subject;
  if (subject?.kind === asset.kind && subject.name === asset.name) return conversation.id;
  // A draft the conversation created beside its subject, such as an App's form page.
  const created = await options.stores.conversations.createdAsset({
    clientInstanceId: options.clientInstanceId,
    conversationId: conversation.id,
    kind: asset.kind,
    name: asset.name
  });
  return created ? conversation.id : undefined;
}

/**
 * The report as it is kept: scrubbed and bounded again, and a folder whose build recorded that
 * it does not use the kit reads "no bridge used" rather than a bridge that never connected.
 */
function keptReport(report: PreviewReport, usesKit: boolean | undefined): PreviewReport {
  const bounded = boundPreviewReport(report);
  return usesKit === false ? { ...bounded, bridge: "not_used" } : bounded;
}
