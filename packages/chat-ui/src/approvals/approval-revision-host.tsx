import { createContext, useContext } from "react";

/**
 * What the workspace does for a reviewer who requested changes away from the
 * conversation the request came from. Both runs start through the same run
 * endpoints the composer uses; nothing on the server starts a revision.
 */
export interface ApprovalRevisionHost {
  currentUserId: string | undefined;
  /**
   * The agent a revision in the reviewer's Personal Workspace runs with: the
   * proposing agent while that workspace offers it, otherwise its default.
   */
  personalWorkspaceAgentName(proposingAgentName: string | undefined): string | undefined;
  /**
   * Starts the revision run and opens its conversation. With `origin` the
   * follow-up goes to the reviewer's own conversation the request came from;
   * a conversation that no longer exists falls back to a new one. Whatever
   * could not be sent is left in the composer for the reviewer to send.
   */
  startRevision(input: ApprovalRevisionStart): void;
}

export interface ApprovalRevisionStart {
  origin?: { conversationId: string; agentName: string | undefined; text: string };
  newConversation: { agentName: string | undefined; text: string };
  /** Shown when the run could not be started and the text waits in the composer. */
  failureNotice: string;
}

export interface ApprovalRevisionRunInput {
  /** Absent for a new conversation in the reviewer's Personal Workspace. */
  conversationId: string | undefined;
  agentName: string | undefined;
  text: string;
}

/**
 * The order in which a revision is attempted, apart from how the workspace
 * starts a run. A run that cannot start never loses the reviewer's message: it
 * is handed to the composer of the conversation it was meant for.
 */
export async function startApprovalRevision(
  input: Pick<ApprovalRevisionStart, "origin" | "newConversation">,
  workspace: {
    startRun(run: ApprovalRevisionRunInput): Promise<void>;
    isConversationGone(error: unknown): boolean;
    leaveInComposer(conversationId: string | undefined, text: string): void;
  }
): Promise<void> {
  const { origin, newConversation } = input;
  if (origin) {
    try {
      await workspace.startRun(origin);
      return;
    } catch (error) {
      // A busy or otherwise unavailable origin conversation is still the place
      // to revise in. Only one that no longer exists is replaced by a new one.
      if (!workspace.isConversationGone(error)) {
        workspace.leaveInComposer(origin.conversationId, origin.text);
        return;
      }
    }
  }
  try {
    await workspace.startRun({ ...newConversation, conversationId: undefined });
  } catch {
    workspace.leaveInComposer(undefined, newConversation.text);
  }
}

const ApprovalRevisionHostContext = createContext<ApprovalRevisionHost | undefined>(undefined);

export const ApprovalRevisionHostProvider = ApprovalRevisionHostContext.Provider;

/** Absent outside the first-party workspace, where a decision is then all that happens. */
export function useApprovalRevisionHost(): ApprovalRevisionHost | undefined {
  return useContext(ApprovalRevisionHostContext);
}
