import type { PlatformStores } from "@vivd-catalyst/core";
import type {
  ApiKeyAccessTokenExchange,
  HmacSessionTokenIssuer,
  StandaloneAuthRuntime
} from "@vivd-catalyst/auth";
import type {
  AgentConfig,
  AgentRuntime,
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  ExecutionWorkspaceCleanupStore,
  ManagedArtifactId
} from "@vivd-catalyst/core";
import type {
  AuditRecorder,
  CentralPolicySetting,
  PlatformEventEmitter,
  RateLimiter
} from "@vivd-catalyst/core";
import type { OperationApprovalRequests } from "@vivd-catalyst/tool-execution";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { CapturedMail, MailSender } from "@vivd-catalyst/mail";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { ChatAttachmentService } from "./attachments";
import type { ApprovalRequestWorkflowOptions } from "./approval-request-workflow";

export interface ConversationRetentionOptions {
  batchSize?: number;
  now?: () => Date;
}

export interface RunRecoveryOptions {
  staleActiveRunMs?: number;
  batchSize?: number;
}

export interface ExecutionWorkspaceCleanupJobOptions {
  batchSize?: number;
  /** Milliseconds between two runs of the `execution_workspace.cleanup` job. */
  checkIntervalMs?: number;
  now?: () => Date;
}

export interface ChatServerOptions {
  logger: import("@vivd-catalyst/core").Logger;
  approvalRequests?: Pick<ApprovalRequestWorkflowOptions, "store" | "handlers" | "onDecided">;
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  authAdapter: AuthAdapter;
  stores: PlatformStores;
  usageGovernance: ModelUsageGovernance;
  auditRecorder: AuditRecorder;
  configAssets: {
    store: ConfigAssetStore;
    source: ConfigAssetSource;
    validationRefs: {
      modelProviderIds: string[];
      modelBindingIds: string[];
      modelBindings: Array<{ id: string; model: string }>;
      fastModeModelBindingIds: string[];
      reasoningEfforts: string[];
      enabledToolNames: string[];
    };
    validateAgents?(agents: AgentConfig[]): string[];
  };
  agentRuntime: AgentRuntime;
  attachments?: ChatAttachmentService;
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
  modelProvider: ModelProvider;
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

/** The options as the server's own modules see them, with every default filled in. */
export type ResolvedChatServerOptions = ChatServerOptions &
  Required<Pick<ChatServerOptions, "rateLimiter">>;
