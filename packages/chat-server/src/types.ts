import type {
  ApiKeyAccessTokenExchange,
  HmacSessionTokenIssuer,
  StandaloneAuthRuntime
} from "@vivd-catalyst/auth";
import type {
  AgentConfig,
  AgentRuntime,
  AgentRunStore,
  ApiAccessStore,
  AuditEventStore,
  ClientInstanceId,
  CollaborationWorkspaceStore,
  ConfigAssetSource,
  ConfigAssetStore,
  ConversationRetentionStore,
  ConversationStore,
  ExecutionWorkspaceCleanupStore,
  ManagedArtifactId,
  PlatformFileStore,
  RunObservationStore,
  StructuredDataStore,
  UserStore,
  WorkspaceCommandStore
} from "@vivd-catalyst/core";
import type { AuditRecorder } from "@vivd-catalyst/core";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { CapturedMail, MailSender } from "@vivd-catalyst/mail";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { ChatAttachmentService } from "./attachments";
import type { ApprovalRequestWorkflowOptions } from "./approval-request-workflow";

export interface ConversationRetentionJobOptions {
  batchSize?: number;
  checkIntervalMs?: number;
  runOnStartup?: boolean;
  now?: () => Date;
}

export interface RunRecoveryOptions {
  staleActiveRunMs?: number;
  watchdogIntervalMs?: number;
  batchSize?: number;
  runOnStartup?: boolean;
}

export interface ExecutionWorkspaceCleanupJobOptions {
  batchSize?: number;
  checkIntervalMs?: number;
  runOnStartup?: boolean;
  now?: () => Date;
}

export interface ChatServerOptions {
  logger: import("@vivd-catalyst/core").Logger;
  approvalRequests?: Pick<ApprovalRequestWorkflowOptions, "store" | "handlers" | "onDecided">;
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  authAdapter: AuthAdapter;
  conversationStore: ConversationStore &
    ConversationRetentionStore &
    PlatformFileStore &
    AgentRunStore &
    RunObservationStore &
    StructuredDataStore &
    Pick<WorkspaceCommandStore, "countActiveWorkspaceCommands">;
  auditEventStore: AuditEventStore;
  userStore: UserStore & CollaborationWorkspaceStore;
  apiAccessStore: ApiAccessStore;
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
  retentionExpiration?: ConversationRetentionJobOptions;
  runRecovery?: RunRecoveryOptions;
  modelProvider: ModelProvider;
  allowedOrigins?: string | string[];
  standaloneAuth?: Pick<
    StandaloneAuthRuntime,
    | "handleRequest"
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
}
