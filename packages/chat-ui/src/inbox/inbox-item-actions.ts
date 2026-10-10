import { useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequestView, DraftAttachment } from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import {
  APPROVAL_AUTH_SCOPE,
  useApprovalRequestActions,
  type ApprovalActionFailure,
  type ApprovalDecisionInput
} from "../approvals/approval-request-api";
import {
  approvalRevisionHintKey,
  approvalRevisionPlan,
  shouldSendApprovalFollowUp
} from "../approvals/approval-request-model";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";
import { buildApprovalRevisionMessage } from "../approvals/approval-revision-message";
import { useAttachmentContentContext } from "../attachment-content";
import { useToolDisplayActions } from "../domain-ui-widgets";
import { useTranslation, type TranslationKey } from "../i18n";
import { useWorkspaceDraftController } from "../workspace/workspace-drafts";

/** What a person can do to an item, for the frame's foot and for a kind's own foot. */
export interface InboxItemActions {
  /** An action is on its way: the buttons are held. */
  pending: boolean;
  failure?: ApprovalActionFailure;
  decide(decision: ApprovalDecisionInput): void;
  withdraw(): void;
  revert(): void;
  /** What requesting changes sets off, in one sentence. Absent when nothing follows. */
  revisionHintKey?: TranslationKey;
}

/**
 * The item's actions plus what follows "request changes". The reviewer who asks for a revision
 * is also the one who gets it: in the conversation on screen, in their own origin conversation,
 * or in a new one.
 */
export function useInboxItemActions(
  itemId: string,
  item: ApprovalRequestView | undefined
): InboxItemActions {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const originConversationId = item?.origin?.conversationId;
  const openConversationId = useAttachmentContentContext()?.selectedConversationId;
  // Absent while the open conversation cannot take a message, a running run included.
  const sendMessage = useToolDisplayActions()?.sendMessage;
  const revisionHost = useApprovalRevisionHost();
  const queryClient = useQueryClient();
  const composerDraftText = useWorkspaceDraftController().draftFor({
    authScope: APPROVAL_AUTH_SCOPE,
    conversationId: openConversationId
  });
  const revisionPlan = item
    ? approvalRevisionPlan({
        originConversationId,
        openConversationId,
        requestedById: item.requestedBy.id,
        currentUserId: revisionHost?.currentUserId
      })
    : undefined;
  const actions = useApprovalRequestActions({
    apiBaseUrl,
    authScope: APPROVAL_AUTH_SCOPE,
    client,
    requestId: itemId,
    originConversationId,
    onDecided(decision) {
      if (decision.decision !== "request_changes" || !item || !revisionPlan) {
        return false;
      }
      if (revisionPlan.kind !== "open_conversation") {
        const proposingAgentName = item.origin?.agentName;
        revisionHost?.startRevision({
          ...(revisionPlan.kind === "origin_conversation"
            ? {
                origin: {
                  conversationId: revisionPlan.conversationId,
                  agentName: proposingAgentName,
                  // The comment is in the decision the agent reads there.
                  text: t("approvalFollowUpMessage")
                }
              }
            : {}),
          newConversation: {
            agentName: revisionHost.personalWorkspaceAgentName(proposingAgentName),
            text: buildApprovalRevisionMessage({ request: item, comment: decision.comment, t })
          },
          failureNotice: t("approvalRevisionStartFailed")
        });
        return false;
      }
      const followUp = shouldSendApprovalFollowUp({
        decision: decision.decision,
        originConversationId,
        openConversationId,
        canSendMessage: Boolean(sendMessage),
        composerDraftText,
        // The composer's own list, in every state. A file still uploading is
        // not in it yet, but blocks sending and so leaves `sendMessage` absent.
        draftAttachmentCount:
          queryClient.getQueryData<DraftAttachment[]>(
            workspaceQueryKeys.draftAttachments(apiBaseUrl, APPROVAL_AUTH_SCOPE, openConversationId)
          )?.length ?? 0
      });
      if (followUp) {
        // The comment is in the decision the agent reads; this only starts the run.
        sendMessage?.(t("approvalFollowUpMessage"));
      }
      return followUp;
    }
  });

  return {
    pending: actions.pending,
    failure: actions.failure,
    decide: actions.decide,
    withdraw: actions.withdraw,
    revert: actions.revert,
    revisionHintKey:
      revisionPlan && (revisionPlan.kind === "open_conversation" || revisionHost)
        ? approvalRevisionHintKey(revisionPlan)
        : undefined
  };
}
