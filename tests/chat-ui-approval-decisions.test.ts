import { fromThreadMessageLike } from "@assistant-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "@vivd-catalyst/api-client";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import { ApprovalDecisionLine } from "../packages/chat-ui/src/approvals/approval-decision-line";
import {
  APPROVAL_REQUEST_DISPLAY_KIND,
  approvalRevisionHintKey,
  approvalRevisionPlan,
  shouldSendApprovalFollowUp,
  type ApprovalDecisionStatus
} from "../packages/chat-ui/src/approvals/approval-request-model";
import {
  startApprovalRevision,
  type ApprovalRevisionRunInput
} from "../packages/chat-ui/src/approvals/approval-revision-host";
import {
  toUiMessages,
  type AssistantUiApprovalDecision,
  type AssistantUiMessageMetadata
} from "../packages/chat-ui/src/assistant/assistant-ui-adapter";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";

const MODEL_NOTE = "Approval request apr_1 (skill_change) was decided.";

function message(overrides: Partial<Message> & Pick<Message, "id" | "role">): Message {
  return {
    conversationId: "conv_1",
    clientInstanceId: "client_1",
    text: "",
    createdAt: "2026-10-05T08:00:00.000Z",
    ...overrides
  };
}

function decisionMessage(
  status: ApprovalDecisionStatus,
  overrides: { requestId?: string; comment?: string; summary?: string; requestedBy?: string } = {}
): Message {
  const requestId = overrides.requestId ?? "apr_1";
  return message({
    id: `msg_${requestId}_${status}`,
    role: "system",
    text: MODEL_NOTE,
    metadata: {
      agentRuntime: {
        version: 1,
        kind: "approval_decision",
        requestId,
        requestKind: "skill_change",
        status,
        decidedBy: "user-bert",
        decidedByLabel: "Bert Prüfer",
        decidedAt: "2026-10-05T09:30:00.000Z",
        summary: overrides.summary ?? "Auch die Steuerklasse prüfen.",
        ...(overrides.comment ? { comment: overrides.comment } : {}),
        ...(overrides.requestedBy ? { requestedBy: overrides.requestedBy } : {})
      }
    }
  });
}

function proposalRunMessages(runId: string, requestId: string): Message[] {
  const toolCall = { toolCallId: `call_${runId}`, toolName: "propose_skill_change", input: {} };
  return [
    message({
      id: `msg_${runId}_calls`,
      role: "assistant",
      metadata: createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })
    }),
    message({
      id: `msg_${runId}_result`,
      role: "tool",
      metadata: createToolResultMetadata({
        runId,
        toolCall,
        result: {
          status: "success",
          output: {},
          display: { kind: APPROVAL_REQUEST_DISPLAY_KIND, version: 1, data: { requestId } }
        },
        modelOutput: { text: "submitted" }
      })
    }),
    message({
      id: `msg_${runId}_final`,
      role: "assistant",
      text: "Ich habe einen Vorschlag eingereicht.",
      metadata: createAssistantFinalMetadata({ runId })
    })
  ];
}

function readDecision(
  uiMessage: ReturnType<typeof toUiMessages>[number] | undefined
): AssistantUiApprovalDecision | undefined {
  return (uiMessage?.metadata as AssistantUiMessageMetadata | undefined)?.custom?.approvalDecision;
}

function renderLine(
  decision: AssistantUiApprovalDecision | undefined,
  locale: "de" | "en" = "de"
): string {
  if (!decision) {
    throw new Error("Expected an approval decision");
  }
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(ApprovalDecisionLine, { decision, showSummary: decision.ambiguous })
    )
  );
}

describe("approval decision in the thread", () => {
  const expectedLines: Record<ApprovalDecisionStatus, { de: string; en: string }> = {
    approved: { de: "Übernommen von Bert Prüfer", en: "Accepted by Bert Prüfer" },
    rejected: { de: "Abgelehnt von Bert Prüfer", en: "Rejected by Bert Prüfer" },
    changes_requested: {
      de: "Änderung gewünscht von Bert Prüfer",
      en: "Changes requested by Bert Prüfer"
    },
    superseded: { de: "Nicht mehr anwendbar", en: "No longer applicable" },
    withdrawn: { de: "Zurückgezogen", en: "Withdrawn" },
    reverted: { de: "Rückgängig gemacht von Bert Prüfer", en: "Undone by Bert Prüfer" }
  };

  for (const status of Object.keys(expectedLines) as ApprovalDecisionStatus[]) {
    it(`projects a ${status} decision to a status line instead of a chat message`, () => {
      const [projected, ...rest] = toUiMessages([decisionMessage(status)]);

      expect(rest).toEqual([]);
      expect(projected?.role).toBe("system");
      // The stored text is the note for the model and must not reach the thread.
      expect(JSON.stringify(projected)).not.toContain(MODEL_NOTE);
      expect(readDecision(projected)).toEqual({
        requestId: "apr_1",
        status,
        decidedByLabel: "Bert Prüfer",
        decidedAt: "2026-10-05T09:30:00.000Z",
        summary: "Auch die Steuerklasse prüfen.",
        ambiguous: false
      });

      const german = renderLine(readDecision(projected));
      expect(german).toContain(expectedLines[status].de);
      expect(german).toContain('dateTime="2026-10-05T09:30:00.000Z"');
      expect(german).toContain(`data-status="${status}"`);
      // One proposal in the thread: the line needs no summary to be understood.
      expect(german).not.toContain("Steuerklasse");
      if (status === "superseded" || status === "withdrawn") {
        expect(german).not.toContain("Bert Prüfer");
      }
      expect(renderLine(readDecision(projected), "en")).toContain(expectedLines[status].en);
    });
  }

  it("puts the comment on a second line when there is one", () => {
    const withComment = renderLine(
      readDecision(
        toUiMessages([decisionMessage("changes_requested", { comment: "Bitte kürzer fassen." })])[0]
      )
    );
    const withoutComment = renderLine(
      readDecision(toUiMessages([decisionMessage("changes_requested")])[0])
    );

    expect(withComment.match(/<p /gu)).toHaveLength(2);
    expect(withComment).toContain("Bitte kürzer fassen.");
    expect(withoutComment.match(/<p /gu)).toHaveLength(1);
  });

  it("is a system message assistant-ui accepts and keeps the decision on", () => {
    const [projected] = toUiMessages([decisionMessage("approved", { comment: "Passt." })]);
    const normalized = fromThreadMessageLike(
      {
        role: "system",
        content: [{ type: "text", text: "" }],
        metadata: { custom: { approvalDecision: readDecision(projected) } }
      },
      projected?.id ?? "",
      { type: "complete", reason: "stop" }
    );

    expect(projected?.parts).toEqual([{ type: "text", text: "", state: "done" }]);
    expect(normalized.metadata.custom).toMatchObject({
      approvalDecision: { status: "approved", comment: "Passt." }
    });
  });

  it("drops any other system message instead of showing its text", () => {
    expect(
      toUiMessages([message({ id: "msg_system", role: "system", text: "internal note" })])
    ).toEqual([]);
  });

  it("names the proposal only when the thread holds several", () => {
    const projected = toUiMessages([
      ...proposalRunMessages("run_1", "apr_1"),
      decisionMessage("changes_requested"),
      message({ id: "msg_user", role: "user", text: "Bitte überarbeite den Vorschlag." }),
      ...proposalRunMessages("run_2", "apr_2"),
      decisionMessage("superseded"),
      decisionMessage("approved", { requestId: "apr_2", summary: "Zweiter Vorschlag." })
    ]);
    const decisions = projected.map(readDecision).filter((decision) => decision !== undefined);

    expect(decisions.map((decision) => decision.ambiguous)).toEqual([true, true, true]);
    expect(renderLine(decisions[0])).toContain("Auch die Steuerklasse prüfen.");
    expect(renderLine(decisions[2])).toContain("Zweiter Vorschlag.");
  });

  it("counts a proposal that is still waiting when deciding whether a line is ambiguous", () => {
    const projected = toUiMessages([
      ...proposalRunMessages("run_1", "apr_1"),
      ...proposalRunMessages("run_2", "apr_2"),
      decisionMessage("approved")
    ]);

    expect(readDecision(projected.at(-1))?.ambiguous).toBe(true);
  });

  it("leaves the assistant work of a run grouped when a decision lands inside it", () => {
    const [toolCalls, toolResult, final] = proposalRunMessages("run_2", "apr_2");
    if (!toolCalls || !toolResult || !final) {
      throw new Error("Expected a complete run");
    }
    const user = message({ id: "msg_user", role: "user", text: "Noch ein Vorschlag bitte." });
    const decision = decisionMessage("approved");

    const undisturbed = toUiMessages([user, toolCalls, toolResult, final]);
    const interleaved = toUiMessages([user, toolCalls, decision, toolResult, final]);

    expect(interleaved.map((uiMessage) => uiMessage.role)).toEqual(["user", "system", "assistant"]);
    expect(interleaved[2]).toEqual(undisturbed[1]);
    expect(interleaved[2]?.parts.slice(0, 2).map((part) => part.type)).toEqual([
      "dynamic-tool",
      "text"
    ]);
  });

  it("keeps its place between two completed runs", () => {
    const projected = toUiMessages([
      ...proposalRunMessages("run_1", "apr_1"),
      decisionMessage("rejected"),
      message({ id: "msg_user", role: "user", text: "Danke." })
    ]);

    expect(projected.map((uiMessage) => uiMessage.id)).toEqual([
      "msg_run_1_final",
      "msg_apr_1_rejected",
      "msg_user"
    ]);
  });
});

describe("requested changes in the requester's thread", () => {
  function line(requestedBy: string | undefined, locale: "de" | "en" = "de"): string {
    return renderLine(
      readDecision(toUiMessages([decisionMessage("changes_requested", { requestedBy })])[0]),
      locale
    );
  }

  it("says that the reviewer is revising a proposal they sent back to someone else", () => {
    expect(line("user-anna")).toContain(
      "Bert Prüfer hat eine Änderung gewünscht und überarbeitet den Vorschlag"
    );
    expect(line("user-anna", "en")).toContain(
      "Bert Prüfer requested changes and is revising the proposal"
    );
    expect(line("user-anna")).not.toContain("<button");
  });

  it("keeps the plain line for the requester's own decision and for older decisions", () => {
    expect(line("user-bert")).toContain("Änderung gewünscht von Bert Prüfer");
    expect(line(undefined)).toContain("Änderung gewünscht von Bert Prüfer");
    expect(line("user-bert")).not.toContain("überarbeitet");
  });
});

describe("who revises where after requesting changes", () => {
  const request = { originConversationId: "conv_origin", requestedById: "user-anna" };

  it("stays in the open conversation when the reviewer decides where the request came from", () => {
    for (const currentUserId of ["user-anna", "user-bert", undefined]) {
      expect(
        approvalRevisionPlan({ ...request, openConversationId: "conv_origin", currentUserId })
      ).toEqual({ kind: "open_conversation" });
    }
  });

  it("opens a new conversation for someone else's request decided from the review queue", () => {
    expect(
      approvalRevisionPlan({
        ...request,
        openConversationId: undefined,
        currentUserId: "user-bert"
      })
    ).toEqual({ kind: "new_conversation" });
  });

  it("goes back to the origin conversation for the reviewer's own request", () => {
    expect(
      approvalRevisionPlan({
        ...request,
        openConversationId: undefined,
        currentUserId: "user-anna"
      })
    ).toEqual({ kind: "origin_conversation", conversationId: "conv_origin" });
  });

  it("never sends a reviewer into a conversation that is not known to be theirs", () => {
    expect(
      approvalRevisionPlan({ ...request, openConversationId: undefined, currentUserId: undefined })
    ).toEqual({ kind: "new_conversation" });
    expect(
      approvalRevisionPlan({
        ...request,
        openConversationId: "conv_other",
        currentUserId: "user-bert"
      })
    ).toEqual({ kind: "new_conversation" });
  });

  it("opens a new conversation for an own request that has no origin conversation", () => {
    expect(
      approvalRevisionPlan({
        originConversationId: undefined,
        openConversationId: undefined,
        requestedById: "user-anna",
        currentUserId: "user-anna"
      })
    ).toEqual({ kind: "new_conversation" });
  });

  it("has a hint for each place", () => {
    expect(approvalRevisionHintKey({ kind: "open_conversation" })).toBe(
      "approvalRevisionHintOpenConversation"
    );
    expect(approvalRevisionHintKey({ kind: "new_conversation" })).toBe(
      "approvalRevisionHintNewConversation"
    );
    expect(approvalRevisionHintKey({ kind: "origin_conversation", conversationId: "c" })).toBe(
      "approvalRevisionHintOriginConversation"
    );
  });
});

describe("starting a revision away from the open conversation", () => {
  const origin = { conversationId: "conv_origin", agentName: "writer", text: "Please revise." };
  const newConversation = { agentName: "default", text: "Please revise this proposed change…" };

  async function start(
    input: { origin?: typeof origin },
    failures: Record<string, unknown> = {}
  ): Promise<{ runs: ApprovalRevisionRunInput[]; composer: Array<[string | undefined, string]> }> {
    const runs: ApprovalRevisionRunInput[] = [];
    const composer: Array<[string | undefined, string]> = [];
    await startApprovalRevision(
      { ...input, newConversation },
      {
        async startRun(run) {
          runs.push(run);
          const failure = failures[run.conversationId ?? "new"];
          if (failure) {
            throw failure;
          }
        },
        isConversationGone: (error) => error === "gone",
        leaveInComposer: (conversationId, text) => composer.push([conversationId, text])
      }
    );
    return { runs, composer };
  }

  it("starts a new conversation with the whole proposal for someone else's request", async () => {
    expect(await start({})).toEqual({
      runs: [{ ...newConversation, conversationId: undefined }],
      composer: []
    });
  });

  it("sends only the follow-up into the reviewer's own origin conversation", async () => {
    expect(await start({ origin })).toEqual({ runs: [origin], composer: [] });
  });

  it("falls back to a new conversation when the origin conversation is gone", async () => {
    expect(await start({ origin }, { conv_origin: "gone" })).toEqual({
      runs: [origin, { ...newConversation, conversationId: undefined }],
      composer: []
    });
  });

  it("leaves the follow-up in the origin composer while that conversation is busy", async () => {
    expect(await start({ origin }, { conv_origin: "busy" })).toEqual({
      runs: [origin],
      composer: [["conv_origin", origin.text]]
    });
  });

  it("leaves the message in a new conversation's composer when no run can start", async () => {
    expect(await start({}, { new: "offline" })).toEqual({
      runs: [{ ...newConversation, conversationId: undefined }],
      composer: [[undefined, newConversation.text]]
    });
  });
});

describe("follow-up after requesting changes", () => {
  const inOriginThread = {
    decision: "request_changes",
    originConversationId: "conv_1",
    openConversationId: "conv_1",
    canSendMessage: true,
    composerDraftText: "",
    draftAttachmentCount: 0
  } as const;

  it("is sent from the card in the thread the request came from", () => {
    expect(shouldSendApprovalFollowUp(inOriginThread)).toBe(true);
  });

  it("is not sent from the review queue, where no conversation is open", () => {
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, openConversationId: undefined })).toBe(
      false
    );
  });

  it("is not sent into a conversation other than the originating one", () => {
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, openConversationId: "conv_2" })).toBe(
      false
    );
    expect(
      shouldSendApprovalFollowUp({
        ...inOriginThread,
        originConversationId: undefined,
        openConversationId: undefined
      })
    ).toBe(false);
  });

  it("is not sent while a run is active or sending is otherwise unavailable", () => {
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, canSendMessage: false })).toBe(false);
  });

  it("is not sent while the composer holds draft text", () => {
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, composerDraftText: "Noch etwas" })).toBe(
      false
    );
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, composerDraftText: "  \n" })).toBe(true);
  });

  it("is not sent while the composer holds a draft attachment", () => {
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, draftAttachmentCount: 1 })).toBe(false);
  });

  it("is not sent for any other decision", () => {
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, decision: "approve" })).toBe(false);
    expect(shouldSendApprovalFollowUp({ ...inOriginThread, decision: "reject" })).toBe(false);
  });
});
