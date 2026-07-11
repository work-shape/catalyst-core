import type { HmacSessionTokenIssuer, StandaloneAuthRuntime } from "@vivd-catalyst/auth";
import type {
  AgentConfig,
  AgentRuntime,
  AgentRunStore,
  AuditEventStore,
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  ConversationRetentionStore,
  ConversationStore,
  ExecutionWorkspaceCleanupStore,
  ManagedArtifactId,
  PlatformFileStore,
  RunObservationStore,
  UserStore
} from "@vivd-catalyst/core";
import type { AuditRecorder } from "@vivd-catalyst/core";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { ChatAttachmentService } from "./attachments";
import type { ConversationRetentionJobOptions } from "./retention";
import type { RunRecoveryOptions } from "./run-recovery";
import type { ExecutionWorkspaceCleanupJobOptions } from "./workspace-cleanup";

export interface ChatServerOptions {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  authAdapter: AuthAdapter;
  conversationStore: ConversationStore &
    ConversationRetentionStore &
    PlatformFileStore &
    AgentRunStore &
    RunObservationStore;
  auditEventStore: AuditEventStore;
  userStore: UserStore;
  usageGovernance: ModelUsageGovernance;
  auditRecorder: AuditRecorder;
  configAssets: {
    store: ConfigAssetStore;
    source: ConfigAssetSource;
    validationRefs: {
      modelProviderIds: string[];
      modelBindingIds: string[];
      modelBindings: Array<{ id: string; model: string }>;
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
  corsOrigin?: string | string[];
  standaloneAuth?: Pick<
    StandaloneAuthRuntime,
    | "handleRequest"
    | "baseUrl"
    | "setPassword"
    | "setOrCreatePasswordSignIn"
    | "changePassword"
    | "deletePasswordSignIn"
  >;
  sessionToken?: {
    issuer: HmacSessionTokenIssuer;
    serverCredential: string;
  };
}
