import type { JobRetry, PlatformStores } from "@vivd-catalyst/core";
import type {
  ApiKeyAccessTokenExchange,
  HmacSessionTokenIssuer,
  StandaloneAuthRuntime
} from "@vivd-catalyst/auth";
import type {
  AgentRuntime,
  AssetBuildClient,
  AssetKindRegistry,
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  ExecutionWorkspaceCleanupStore,
  ManagedArtifactId,
  ModuleSnapshot,
  ObjectStorage
} from "@vivd-catalyst/core";
import type {
  AuditRecorder,
  ApprovalRequestHandlerRegistry,
  Authorizer,
  CentralPolicySetting,
  OperationRegistry,
  PlatformEventEmitter,
  RateLimiter
} from "@vivd-catalyst/core";
import type { OperationApprovalRequests, RunOperationDeps } from "@vivd-catalyst/tool-execution";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { CapturedMail, MailSender } from "@vivd-catalyst/mail";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type {
  ConfigAssetValidationRefs,
  PlatformInstructions,
  WorkflowAssetKind
} from "./asset-kinds/shared";
import type { ChatAttachmentService } from "./attachments";
import type { InfrastructureWorkflow } from "./infrastructure-workflow";
import type { ConnectionManagementPort } from "./connection-management-port";
import type { SystemModelGateway } from "./system-model-call";
import type { ApprovalRequestWorkflowOptions } from "./approval-request-workflow";
import type { AssetRepoCommitClient } from "./asset-repo-jobs";

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
}

export interface ChatServerOptions {
  logger: import("@vivd-catalyst/core").Logger;
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
  managedObjects?: {
    readArtifact(input: {
      clientInstanceId: ClientInstanceId;
      artifactId: ManagedArtifactId;
    }): Promise<{
      bytes: Uint8Array;
      mimeType: string;
    }>;
  };
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
  >;
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
    /** The events of a call. Without one, audited events become audit rows and nothing blocks. */
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
