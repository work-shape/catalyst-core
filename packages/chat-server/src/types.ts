import type { HmacSessionTokenIssuer, StandaloneAuthRuntime } from "@vivd-catalyst/auth";
import type {
  AgentRuntime,
  AuditEventStore,
  ClientInstanceId,
  ConversationRetentionStore,
  ConversationStore,
  PlatformFileStore,
  UserStore
} from "@vivd-catalyst/core";
import type { AuditRecorder } from "@vivd-catalyst/core";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { ChatAttachmentService } from "./attachments";
import type { ConversationRetentionJobOptions } from "./retention";

export interface ChatServerOptions {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  authAdapter: AuthAdapter;
  conversationStore: ConversationStore & ConversationRetentionStore & PlatformFileStore;
  auditEventStore: AuditEventStore;
  userStore: UserStore;
  usageGovernance: ModelUsageGovernance;
  auditRecorder: AuditRecorder;
  agentRuntime: AgentRuntime;
  attachments?: ChatAttachmentService;
  retentionExpiration?: ConversationRetentionJobOptions;
  modelProvider: ModelProvider;
  corsOrigin?: string | string[];
  standaloneAuth?: Pick<
    StandaloneAuthRuntime,
    "handleRequest" | "baseUrl" | "setPassword" | "changePassword"
  >;
  sessionToken?: {
    issuer: HmacSessionTokenIssuer;
    serverCredential: string;
  };
}
