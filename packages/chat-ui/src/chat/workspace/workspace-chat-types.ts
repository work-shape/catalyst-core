import type { DockCreationScope, DockPageChat } from "../../shared/dock-page-chat";
import type { CreationTarget } from "../dock/creation-target";
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
import type { BuildWorkspace } from "../../shared/build-rights";
import { type AppRights } from "../../studio/apps/app-model";
import {
  type InstanceTimeZone,
  type WorkflowRights,
  type WorkflowsAccess
} from "../../studio/workflows/workflow-model";
import { type ApprovalRevisionHost } from "../approvals/approval-revision-host";
import type { LocalUploadingAttachment } from "../assistant/assistant-composer";
import type { SendBlock } from "../assistant/send-block";
import { type ConversationControllerState } from "../conversation/conversation-controller-state";
import { type AgentOpens } from "../conversation/use-agent-opens";
import type { ChatFileDropzoneController } from "../files/chat-file-dropzone";
import { type AgentSelectableModel, type ReasoningEffort } from "./agent-model-selection";
import { type WorkspaceDock } from "./use-workspace-dock";
import type { WorkspaceView } from "./workspace-rail";
import type { PlatformFailure } from "../platform-report/platform-report";
import type { RunContinueOffer } from "./workspace-chat-state";

export interface WorkspaceChatModelInput {
  administration: ChatShellAdministration | undefined;
  manageDocumentTitle: boolean | undefined;
  /** False for embedded token sessions, which stay fixed-context. */
  collaborationWorkspacesAvailable: boolean;
}

export interface WorkspaceChatModel {
  dockChat: DockChatModel;
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
  projects: ProjectsModel;
}

/** Projects of the open workspace (PRJ-1). */
interface ProjectsModel {
  /** The instance's module is on and the session has workspaces. */
  enabled: boolean;
  /** The project of the open conversation, while the module is on. */
  selectedProjectId?: string;
}

/** The one way into the dock from every page: the page head's "Chat" and the dock's "New chat". */
interface DockChatModel {
  /** Opens the dock: a running answer, the page's own conversation, the last one, or a new one. */
  open(): void;
  /** Starts a new conversation for the page in the dock. */
  newChat(): void;
  /** Where the page on screen offers its own conversation, such as about its asset. */
  offerPageChat(chat: DockPageChat | undefined): void;
  /** Where the page on screen builds: the owner Studio is set to. */
  offerCreationScope(scope: DockCreationScope | undefined): void;
}

/** What the workspace knows about Workflows: whether the area is there, and the reader's rights. */
interface WorkflowsModel {
  access: WorkflowsAccess;
  rights: WorkflowRights;
  /** The workspaces the reader knows, as Studio names them: where "Teilen…" of one leads. */
  places?: readonly BuildWorkspace[];
  /**
   * The instance's time zone, for a schedule saved without one of its own; `defaulted`: the
   * instance sets none, so it is UTC. Absent until the instance has answered.
   */
  instanceTimeZone?: InstanceTimeZone;
  /**
   * Starts a conversation of the open workspace about this Workflow and opens it, with `prompt`
   * in its composer where one is given. Rejects where the instance refuses the conversation.
   */
  editWithAgent(workflow: string, prompt?: string, options?: { fresh: boolean }): Promise<void>;
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
  /** The workspaces the reader knows, as Studio names them: where "Teilen…" of an App leads. */
  places?: readonly BuildWorkspace[];
  /** Opens a new conversation of the open workspace with this text in its composer. */
  startChat(prompt: string): void;
  /**
   * Starts a conversation of the open workspace about this App and opens it, with the App's
   * draft beside it. Rejects where the instance refuses the conversation.
   */
  editWithAgent(app: string, options?: { fresh: boolean }): Promise<void>;
  /**
   * "Edit in chat": a new conversation with the agent that builds, holding the App's current
   * draft and its files, in the dock beside the App's draft. Absent where no agent here builds.
   */
  editInChat?(app: string): Promise<void>;
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
  /** The person signed in, but an administrator disabled their account. */
  accountDisabled: boolean;
  /** The instance requires two-factor sign-in and this person has not set it up yet. */
  twoFactorSetupRequired: boolean;
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
  /** The person's own agents ("Nur ich") the chat on screen cannot choose, as others read it. */
  ownAgentsElsewhere: SafeConfig["agents"];
  /** The open conversation's thread has not loaded, so the agent it was held with is not known yet. */
  activeAgentLoading: boolean;
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
  /** The session has workspaces: the Scheduled row shows. */
  scheduled: boolean;
  /** The Projects module is on and the session has workspaces: the Projects row shows. */
  projects: boolean;
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
  /** The quiet note at 80 percent of the person's own spend limit, until they dismiss it. */
  usageNote?: { text: string; dismiss(): void };
  selectedConversationId: string | undefined;
  /** The open conversation's retention date, once its thread has loaded. */
  selectedConversationRetainedUntil: string | undefined;
  /** The asset the open conversation is about, once its thread has loaded. */
  selectedConversationSubject: { kind: string; name: string } | undefined;
  /**
   * The workspace the open conversation belongs to, once its thread has loaded: where an asset
   * its first save made stands. Undefined in an embedded session, which reads no workspace.
   */
  selectedConversationWorkspaceId: string | undefined;
  /** The open conversation's title, once its thread has loaded. */
  selectedConversationTitle: string | undefined;
  /** Who started the selected conversation; unknown until its thread is read. */
  selectedConversationOwnerId: string | undefined;
  /**
   * Sends `text` as the person's message to a conversation, queued behind a run that goes
   * (CHAT-CONN-1): a Connect card's word that the service is connected.
   */
  tellConversation(to: { conversationId: string; agentName?: string }, text: string): Promise<void>;
  /**
   * The chat route names a conversation the instance refused to read: deleted, expired, in a
   * workspace the person does not reach, or never made. The dock never reports one.
   */
  conversationGone: boolean;
  /** Opens a new conversation of the active workspace, as the rail's New chat does. */
  startNewConversation(): void;
  /** The conversation stands in the dock of a page, not on its chat route. */
  docked: boolean;
  /**
   * The kind of asset the page beside the dock is about, such as `workflow` beside the
   * Workflows: a new conversation there is about building one.
   */
  dockKind: string | undefined;
  /** Where a new asset of `dockKind` that the dock's agent creates will belong. */
  dockTarget: CreationTarget | undefined;
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
  /** Where the notice is a run's platform failure: the run, to report it to the operator. */
  noticeReport?: { runId: string; failure: PlatformFailure };
  /**
   * Where the notice is of a run the model provider stopped for too many requests and the person
   * owns the conversation: the run and when its wait is over, to go on with one click (T6).
   */
  noticeContinue?: RunContinueOffer;
  draft: string;
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  /** The active agent's own model first, then the models users may pick instead. */
  selectableModels: AgentSelectableModel[];
  /**
   * The open conversation holds data from personal connections: a model marked
   * `personalDataBlocked` shows disabled (MODEL-REGION-3).
   */
  personalData: boolean;
  /** No model the agent offers may be used in it; the composer points to a new conversation. */
  noModelForPersonalData: boolean;
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
  /** The agent of each run of the open conversation, oldest first: its agent change lines. */
  runAgents: ReadonlyArray<{ inputMessageId: string; agentName: string }>;
  /** The open conversation's queue of follow-up messages. */
  followUpSource: FollowUpSource;
  sendBlock: SendBlock | undefined;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  fileDropzone: ChatFileDropzoneController;
  changeDraft(value: string): void;
  selectFiles(files: File[]): void;
  /** Uploads the files a new conversation's first message carries; answers that conversation. */
  sendStagedFiles(): Promise<string | undefined>;
  removeDraftAttachment(attachmentId: string): void;
  retryDraftAttachment(attachmentId: string): void;
  conversationStarted(conversationId: string): void;
  messageSubmitted(conversationId: string): void;
  runStarted(response: StartConversationRunResponse): void;
  streamError(conversationId: string, message: string, viewed: boolean): void;
  cancelSelectedRun(): void;
  /**
   * Goes on in a private conversation of the same workspace with this text in its composer,
   * after a build was refused because others read the open one. Settles once it opened.
   */
  continuePrivately?(prompt: string): Promise<void>;
  /** The first message on the start page makes a private conversation: "Continue privately". */
  startsPrivate?: boolean;
  /** The project the start page's first message starts its chat in, on the project's page. */
  startProjectId?: string;
}

export interface ToolDisplayModel {
  open: boolean;
}
