import {
  type ApiClient,
  type ApiUser,
  type ConversationListItem,
  type DraftAttachment,
  type LocaleCode,
  type Message,
  type SafeConfig,
  type StartConversationRunResponse
} from "@work-shape/catalyst-api-client";
import type { FollowUpSource } from "../conversation/use-follow-up-queue";
import type { ThemeInputs } from "@work-shape/catalyst-ui/theme";
import { type ControlPlaneModel } from "../../admin/control-plane/control-plane-model";
import { type CollaborationWorkspaceModel } from "../../shared/collaboration-workspace/collaboration-workspace-model";
import type { ChatShellAdministration } from "../../shared/page-definition";
import type { ResolvedThemeMode } from "../../shared/theme";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { type AgentListStatus } from "../../studio/agents/agents-model";
import { type AppRights } from "../../studio/apps/app-model";
import { type WorkflowRights, type WorkflowsAccess } from "../../studio/workflows/workflow-model";
import { type ApprovalRevisionHost } from "../approvals/approval-revision-host";
import type { LocalUploadingAttachment } from "../assistant/assistant-composer";
import type { SendBlock } from "../assistant/send-block";
import { type ConversationControllerState } from "../conversation/conversation-controller-state";
import { type AgentOpens } from "../conversation/use-agent-opens";
import type { ChatFileDropzoneController } from "../files/chat-file-dropzone";
import { type AgentSelectableModel, type ReasoningEffort } from "./agent-model-selection";
import { type WorkspaceDock } from "./use-workspace-dock";
import type { WorkspaceView } from "./workspace-rail";

export interface WorkspaceChatModelInput {
  administration: ChatShellAdministration | undefined;
  manageDocumentTitle: boolean | undefined;
  /** False for embedded token sessions, which stay fixed-context. */
  collaborationWorkspacesAvailable: boolean;
}

export interface WorkspaceChatModel {
  auth: WorkspaceAuthModel;
  config: WorkspaceConfigModel;
  route: WorkspaceRouteModel;
  chrome: WorkspaceChromeModel;
  collaborationWorkspace: CollaborationWorkspaceModel;
  conversationRail: ConversationRailModel;
  selectedChat: SelectedChatModel;
  controlPlane: ControlPlaneModel;
  toolDisplay: ToolDisplayModel;
  approvalRevision: ApprovalRevisionHost;
  agents: AgentsModel;
  apps: AppsModel;
  workflows: WorkflowsModel;
}

/** What the workspace knows about Workflows: whether the area is there, and the reader's rights. */
interface WorkflowsModel {
  access: WorkflowsAccess;
  rights: WorkflowRights;
  /**
   * Starts a conversation of the open workspace about this Workflow and opens it. Rejects
   * where the instance refuses the conversation.
   */
  editWithAgent(workflow: string): Promise<void>;
  /**
   * Opens the dock on the list with a new conversation with an agent that builds assets and
   * `prompt` in its composer: its first save creates the Workflow. Absent where no agent here
   * builds them, or the person may write no Workflow.
   */
  startNew?(prompt: string): void;
}

/** What the workspace knows for the Agents page. The agents themselves are the picker's. */
interface AgentsModel {
  /** How the open workspace's own list of agents stands. */
  status: AgentListStatus;
  retry(): void;
  /** Opens a new conversation of the open workspace with this agent selected. */
  startChat(agentName: string): void;
}

/** What the workspace knows about Apps: the module's state and the reader's rights. */
interface AppsModel {
  /** The Apps module is on and the session has workspaces to hold Apps. */
  enabled: boolean;
  rights: AppRights;
  /** Opens a new conversation of the open workspace with this text in its composer. */
  startChat(prompt: string): void;
  /**
   * Starts a conversation of the open workspace about this App and opens it, with the App's
   * draft beside it. Rejects where the instance refuses the conversation.
   */
  editWithAgent(app: string): Promise<void>;
  /**
   * Opens the dock on the list with a new conversation with an agent that builds assets and
   * `prompt` in its composer: its first save creates the App. Absent where no agent here builds
   * them, or the person may write no App.
   */
  startNew?(prompt: string): void;
}

export interface WorkspaceAuthModel {
  apiBaseUrl: string;
  user: ApiUser | undefined;
  loginRequired: boolean;
  sessionUnavailable: boolean;
  sessionRetrying: boolean;
  signingOut: boolean;
  signOut(): void;
  /** Opens one of the user's own Settings pages. */
  openSettings(page: OwnSettingsPage): void;
  invalidateCurrentUser(): void;
  retryCurrentUser(): void;
}

export interface WorkspaceConfigModel {
  config: SafeConfig | undefined;
  /**
   * Why the configuration did not load. `outdated`: the answer or the path belongs to another
   * release than this interface, so only a reload helps. `unavailable`: anything else.
   */
  failure: "outdated" | "unavailable" | undefined;
  retrying: boolean;
  retry(): void;
  activeLocale: LocaleCode;
  localePreference: LocaleCode | undefined;
  supportedLocales: LocaleCode[];
  resolvedThemeMode: ResolvedThemeMode;
  /** The instance's theme inputs for the resolved mode; undefined until the config has loaded. */
  theme: ThemeInputs | undefined;
  activeAgentName: string | undefined;
  selectAgentName(agentName: string | undefined): void;
  selectLocale(locale: LocaleCode): void;
  toggleTheme(): void;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
}

/** The pages of the Settings group "You" that the account menu leads to. */
type OwnSettingsPage = "profile" | "language-appearance";

export interface WorkspaceRouteModel {
  route: WorkspaceRoute;
  view: WorkspaceView;
  selectedConversationId: string | undefined;
  /** The chat dock beside every page but the chat route. */
  dock: WorkspaceDock;
  canViewAdministration: boolean;
  /** Opens a route by its value, as the command palette's "Go to" group does. */
  showRoute(route: WorkspaceRoute): void;
}

export interface WorkspaceChromeModel {
  sidebarCollapsed: boolean;
  sidebarDrawerOpen: boolean;
  composerFocusRequestId: number;
  toggleSidebarCollapsed(): void;
  openSidebarDrawer(): void;
  closeSidebarDrawer(): void;
  requestComposerFocus(): void;
}

export interface ConversationRailModel {
  /** The conversations of the active workspace the rail has loaded, latest activity first. */
  conversations: readonly ConversationListItem[];
  /** The conversation on screen as a row, once its thread is there. */
  openConversation: ConversationListItem | undefined;
  /** The workspace holds older conversations than the loaded ones. */
  hasMoreConversations: boolean;
  loadingMoreConversations: boolean;
  /** The last request for older conversations failed. The loaded ones stay. */
  loadMoreConversationsFailed: boolean;
  loadMoreConversations(): void;
  /** How the list stands: still on its first load, failed without a list to show, or there. */
  conversationsStatus: "loading" | "failed" | "ready";
  reloadConversations(): void;
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  /** Present for a person who may decide requests or has made one: the Inbox row shows. */
  inbox: { toDecide: number } | undefined;
  /**
   * The session has workspaces and the instance names the Agents row for the open one: two
   * agents or more are available there, or the person may write one.
   */
  agents: boolean;
  /**
   * The Apps module is on and the instance names the Apps row for the open workspace: its Apps
   * page lists the person an App, or the person may write one there.
   */
  apps: boolean;
  /**
   * The Workflows area is open to the person and the instance names them a Workflow or they
   * may write one: the Workflows row shows.
   */
  workflows: boolean;
  view: WorkspaceView;
  creatingConversation: boolean;
  deletingConversation: boolean;
  canMoveConversation: boolean;
  startNewConversation(): void;
  selectConversation(conversationId: string): void;
  renameConversation(conversationId: string, title: string): Promise<void>;
  moveConversation(conversationId: string, title: string): void;
  deleteConversation(conversationId: string): void;
  selectWorkspaceView(view: WorkspaceView): void;
}

export interface SelectedChatModel {
  client: ApiClient;
  config: SafeConfig | undefined;
  /** The active workspace's agent list has not arrived yet. */
  agentsLoading: boolean;
  /** `config.agents` is the active workspace's list rather than the instance view. */
  agentsWorkspaceScoped: boolean;
  collaborationWorkspaceId: string | undefined;
  /** No conversation yet, and the Shared Workspace would start one as private. */
  newConversationPrivate: boolean;
  selectedConversationId: string | undefined;
  /** The open conversation's retention date, once its thread has loaded. */
  selectedConversationRetainedUntil: string | undefined;
  /** The asset the open conversation is about, once its thread has loaded. */
  selectedConversationSubject: { kind: string; name: string } | undefined;
  /** The open conversation's title, once its thread has loaded. */
  selectedConversationTitle: string | undefined;
  /** The conversation stands in the dock of a page, not on its chat route. */
  docked: boolean;
  /** Goes to a route of the interface, such as the page of that asset. */
  openRoute(route: WorkspaceRoute): void;
  /** The assets the agent opened, and the way to their pages. */
  agentOpens: AgentOpens;
  messages: Message[] | undefined;
  completedRunProjections: ConversationControllerState["completedRunProjections"];
  messagesLoaded: boolean;
  /** How far the selected conversation's thread is; "ready" while no conversation is selected. */
  snapshotStatus: ConversationControllerState["snapshotStatus"];
  notice: string | undefined;
  draft: string;
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  /** The active agent's own model first, then the models users may pick instead. */
  selectableModels: AgentSelectableModel[];
  selectedModelBindingId: string | undefined;
  /** The effort a run with the selected model would use. */
  selectedReasoningEffort: ReasoningEffort | undefined;
  /** That effort when the user picked it; unset leaves the run to the model's default. */
  requestedReasoningEffort: ReasoningEffort | undefined;
  showContextIndicator: boolean;
  contextSnapshot:
    | {
        inputTokens: number;
        compactThresholdTokens: number;
      }
    | undefined;
  selectAgentName(agentName: string): void;
  selectModelBindingId(modelBindingId: string): void;
  selectReasoningEffort(modelBindingId: string, effort: ReasoningEffort): void;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  conversationRunning: boolean;
  activeRun: ConversationControllerState["activeRun"];
  /** The open conversation's queue of follow-up messages. */
  followUpSource: FollowUpSource;
  sendBlock: SendBlock | undefined;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  fileDropzone: ChatFileDropzoneController;
  changeDraft(value: string): void;
  selectFiles(files: File[]): void;
  removeDraftAttachment(attachmentId: string): void;
  retryDraftAttachment(attachmentId: string): void;
  conversationStarted(conversationId: string): void;
  messageSubmitted(conversationId: string): void;
  runStarted(response: StartConversationRunResponse): void;
  streamError(conversationId: string, message: string, viewed: boolean): void;
  cancelSelectedRun(): void;
}

export interface ToolDisplayModel {
  open: boolean;
}
