import { createContext, useContext } from "react";
import type { TranslationContextValue } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";

/**
 * What the workspace does for a reviewer who requested changes away from the
 * conversation the request came from. Both runs start through the same run
 * endpoints the composer uses; nothing on the server starts a revision.
 */
export interface ApprovalRevisionHost {
  currentUserId: string | undefined;
  /** An active instance admin the person can ask, by name, as the instance tells them. */
  instanceAdminName?: string;
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
  /** The name an agent shows under, or nothing for an agent this person does not see. */
  agentDisplayName(agentName: string): string | undefined;
  /** Opens a conversation of the person's own, such as the one a request of theirs came from. */
  openConversation(conversationId: string): void;
  /** Opens an item of the person's Inbox, such as a confirmation that waits for them there. */
  openInboxItem?(itemId: string): void;
  /** Opens a place of the workspace, such as the run or the App a notice links to. */
  openRoute?(route: WorkspaceRoute): void;
  /** Where the Inbox's items come from and lead to, as far as this reader may know. */
  places?: InboxPlaces;
}

/** A workspace as a row of the Inbox names it. */
export interface InboxWorkspace {
  name: string;
  emoji: string | null;
}

/**
 * What an item leads to, in the workspace that owns it. A Workflow the instance owns names no
 * workspace.
 */
export type InboxItemTarget =
  | { kind: "app" | "app-edit"; workspaceId: string; app: string }
  | { kind: "workflow"; workspaceId?: string; workflow: string };

/**
 * What the Inbox knows of the places its items come from: the reader's workspaces by name, and
 * whether the reader may open a place an item leads to. A link that would end on "You may not
 * read this" is never drawn.
 */
export interface InboxPlaces {
  workspace(workspaceId: string, t: TranslationContextValue["t"]): InboxWorkspace | undefined;
  /** The route to what an item leads to, where the reader may open it there. */
  route(target: InboxItemTarget): WorkspaceRoute | undefined;
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
