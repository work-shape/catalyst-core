import type { JobRetry, PlatformStores } from "@work-shape/catalyst-core";
import type {
  ApiKeyAccessTokenExchange,
  HmacSessionTokenIssuer,
  StandaloneAuthRuntime
} from "@work-shape/catalyst-auth";
import type {
  AgentRuntime,
  AssetBuildClient,
  AssetKindRegistry,
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  DataToolSource,
  ExecutionWorkspaceCleanupStore,
  ManagedArtifactId,
  ModuleSnapshot,
  ObjectStorage
} from "@work-shape/catalyst-core";
import type {
  AuditRecorder,
  ApprovalRequestHandlerRegistry,
  Authorizer,
  CentralPolicySetting,
  OperationRegistry,
  PlatformEventEmitter,
  RateLimiter
} from "@work-shape/catalyst-core";
import type {
  OperationApprovalRequests,
  RunOperationDeps
} from "@work-shape/catalyst-tool-execution";
import type { AuthAdapter } from "@work-shape/catalyst-auth";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import type { CapturedMail, MailSender } from "@work-shape/catalyst-mail";
import type { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import type {
  AgentToolReference,
  ConfigAssetValidationRefs,
  PlatformInstructions,
  WorkflowAssetKind
} from "./asset-kinds/shared";
import type { ChatAttachmentService } from "./conversations/attachments";
import type { InfrastructureWorkflow } from "./platform/infrastructure-service";
import type { ConnectionManagementPort } from "./connections/connection-management-port";
import type { SystemModelGateway } from "./guardrails/system-model-call";
import type { ApprovalRequestWorkflowOptions } from "./approvals/approval-request-service";
import type { AssetRepoCommitClient } from "./assets/asset-repo-jobs";
import type { PublishNarrator } from "./publish-narrative/publish-narrator";

export interface ConversationRetentionOptions {
  batchSize?: number;
  now?: () => Date;
}

export interface ExecutionWorkspaceCleanupJobOptions {
  batchSize?: number;
  /** Milliseconds between two runs of the `execution_workspace.cleanup` job. */
  checkIntervalMs?: number;
  now?: () => Date;
}

/**
 * The one call path of an instance's process: the registry every surface reaches its
 * operations through, what a call runs with, and the approval kinds with the one a waiting
 * call is decided on. The API and an Agent Run worker of the same process share it, so a tool
 * an agent calls and an operation a person calls are the same registered thing.
 */
export interface OperationCalls {
  registry: OperationRegistry;
  deps: RunOperationDeps;
  /** The approval kinds the caller gave, with `operation_call` added. */
  approvalRequestHandlers: ApprovalRequestHandlerRegistry;
  /**
   * The publish question's sentence and warnings (PUBQ-1), for an asset read and a held
   * publish's review alike. Absent where the call path was built without it.
   */
  publishNarrator?: PublishNarrator;
}

/** One capability's deletion past the audit retention, with the transaction's stores. */
type InstanceRetention = (input: {
  days: number;
  stores: PlatformStores;
}) => Promise<Readonly<Record<string, number>>>;

export interface ChatServerOptions {
  logger: import("@work-shape/catalyst-core").Logger;
  /**
   * The approval kinds of the instance. The server adds `operation_call`, the kind a call that
   * waits for another person is decided on.
   */
  approvalRequests?: Pick<ApprovalRequestWorkflowOptions, "store" | "handlers" | "onDecided">;
  /**
   * The call path the assembly built, where agents of this process call tools on it too.
   * Without one the server builds its own from the options below.
   */
  operationCalls?: OperationCalls;
  config: ClientInstanceConfig;
  /** Which modules are on, resolved once by the assembly for the API and every worker. */
  modules: ModuleSnapshot;
  /**
   * What the instance runs on, with the checks of its providers. The routes and the scheduled
   * check share this one object. Absent on an API assembled without its providers.
   */
  infrastructure?: InfrastructureWorkflow;
  clientInstanceId: ClientInstanceId;
  authAdapter: AuthAdapter;
  stores: PlatformStores;
  usageGovernance: ModelUsageGovernance;
  auditRecorder: AuditRecorder;
  configAssets: {
    store: ConfigAssetStore;
    source: ConfigAssetSource;
    /** The registered asset kinds, assembled once with the instance. */
    kinds: AssetKindRegistry<WorkflowAssetKind>;
    validationRefs: ConfigAssetValidationRefs;
    /** Live data tools, resolved by the same sources used when an agent runs. */
    dataTools?: DataToolSource;
    /**
     * The tools of `validationRefs.enabledToolNames` with what each tells people, for the agent
     * page. Asked on each read, because the assembly registers its tools after this is built.
     */
    tools?: () => readonly AgentToolReference[];
    /**
     * What the platform tells its agents before their own instructions, shown read-only on an
     * agent's page: the rules every agent gets, and the orientation an agent gets whose
     * definition lists one of `toolNames`.
     */
    platformInstructions?: PlatformInstructions;
  };
  agentRuntime: AgentRuntime;
  /** The instance's Connections, where the module `connections` is on. */
  connections?: ConnectionManagementPort;
  attachments?: ChatAttachmentService;
  /**
   * How ended jobs of kinds that capabilities declare are retried by hand. The server brings
   * those of its own kinds.
   */
  jobRetries?: JobRetry[];
  /**
   * What the capabilities delete past the audit retention, in the transaction that deletes the
   * audit events. Each answers its counts by name, which the `audit.pruned` event records.
   */
  retention?: readonly InstanceRetention[];
  managedObjects?: {
    readArtifact(input: {
      clientInstanceId: ClientInstanceId;
      artifactId: ManagedArtifactId;
    }): Promise<{
      bytes: Uint8Array;
      mimeType: string;
    }>;
  };
  /**
   * The object store of the conversations' Execution Workspaces, where "Edit in chat" on an
   * App's page writes the App's files into a new conversation. Without it that start is refused.
   */
  workspaceObjects?: ObjectStorage;
  executionWorkspaceCleanup?: {
    store: ExecutionWorkspaceCleanupStore;
    objects?: {
      deleteObject(key: string): Promise<void>;
    };
    jobOptions?: ExecutionWorkspaceCleanupJobOptions;
  };
  /**
   * What Pages are stored in and served with. Present where the instance has the `files`
   * object store, whether the module `apps` is on or off: the Pages of a conversation are
   * removed with it either way.
   */
  pages?: {
    /** Dark SRV-1; absent unless the API explicitly enables its service. */
    previewCaptureService?: import("@work-shape/catalyst-core").PreviewCaptureService;
    /** The `files` object store. File sets live below `pages/`. */
    objects: ObjectStorage;
    /**
     * Signs the token in the address a frame loads a Page from. See `deriveAppContentKey`.
     * Present when the module `apps` is on, which needs it.
     */
    contentKey?: Uint8Array;
    /**
     * Builds the files of an asset write. Without one the server queues the build itself, as
     * a save of a Page does. A test hands in one with a shorter wait.
     */
    assetBuilds?: AssetBuildClient;
    /**
     * Has the commit of a save to an asset's repository made. Without one the server queues
     * the commit itself. A test hands in one with a shorter wait.
     */
    assetRepo?: AssetRepoCommitClient;
  };
  /** What the server's own model calls go through, and what tells it what a model can do. */
  modelGateway: SystemModelGateway;
  allowedOrigins?: string | string[];
  standaloneAuth?: Pick<
    StandaloneAuthRuntime,
    | "handleRequest"
    | "routeKind"
    | "baseUrl"
    | "setPassword"
    | "setOrCreatePasswordSignIn"
    | "changePassword"
    | "deletePasswordSignIn"
    | "findPasswordSignIn"
    | "createPasswordSetupToken"
    | "completePasswordSetup"
    | "twoFactorEnrolled"
    | "resetTwoFactor"
  >;
  /**
   * The senders `mail.send` sends as on this instance (MAIL-1): `system` while release config
   * switches `infrastructure.mail.outbound` on, and none otherwise. A grant of
   * `mail_sender.use` names one of them, and only while it is registered.
   */
  mailSenders?: readonly string[];
  mail?: {
    sender: MailSender;
    /** Public URL of the chat UI; emailed links point here. */
    appUrl: string;
    /** Present only with the capture provider; backs the development inspection route. */
    listCaptured?(): CapturedMail[];
  };
  sessionToken?: {
    issuer: HmacSessionTokenIssuer;
    serverCredential: string;
  };
  serviceAccessToken?: {
    exchange: ApiKeyAccessTokenExchange;
  };
  /** Counts calls per operation and caller. Without one the server counts in its own process. */
  rateLimiter?: RateLimiter;
  /** Decides what a caller may do. Without one the evaluator over the instance's access store decides. */
  authorizer?: Authorizer;
  /** What the calls of registered operations run with beyond the server's own defaults. */
  operations?: {
    /**
     * The events of a call. Without one, the guardrails of release config answer at the
     * before-events and audited events become audit rows; one given here does both.
     */
    events?: PlatformEventEmitter;
    /** The admin's policy settings. Without them only the defaults apply. */
    centralPolicySettings?():
      readonly CentralPolicySetting[] | Promise<readonly CentralPolicySetting[]>;
    /** Files the request another person decides. Without it a call that needs one is refused. */
    approvals?: OperationApprovalRequests;
    now?: () => Date;
  };
}

/**
 * What the workflow of the asset operations reads of a process: its stores, its asset kinds,
 * its modules, its audit and, for a kind whose revisions hold files, where those are built
 * and kept. The API process has all of it, and so has every process that runs agents, whose
 * tools read and save the draft of an asset through the same workflow.
 */
export type AssetWorkflowOptions = Pick<
  ChatServerOptions,
  | "logger"
  | "config"
  | "modules"
  | "clientInstanceId"
  | "stores"
  | "auditRecorder"
  | "configAssets"
  | "pages"
  | "authorizer"
  | "operationCalls"
>;

/** The options as the server's own modules see them, with every default filled in. */
export type ResolvedChatServerOptions = ChatServerOptions &
  Required<Pick<ChatServerOptions, "rateLimiter" | "authorizer" | "operationCalls">>;
