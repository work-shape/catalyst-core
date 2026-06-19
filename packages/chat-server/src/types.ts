import type { HmacSessionTokenIssuer, StandaloneAuthRuntime } from "@vivd-catalyst/auth";
import type {
  AgentRuntime,
  AuditEventStore,
  ClientInstanceId,
  ConversationStore,
  DocumentAttachmentStore,
  UserStore
} from "@vivd-catalyst/core";
import type { AuditRecorder } from "@vivd-catalyst/core";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { ChatAttachmentService } from "./attachments";

export interface ChatServerOptions {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  authAdapter: AuthAdapter;
  conversationStore: ConversationStore & DocumentAttachmentStore;
  auditEventStore: AuditEventStore;
  userStore: UserStore;
  usageGovernance: ModelUsageGovernance;
  auditRecorder: AuditRecorder;
  agentRuntime: AgentRuntime;
  attachments?: ChatAttachmentService;
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
