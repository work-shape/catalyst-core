import type { HmacSessionTokenIssuer, StandaloneAuthRuntime } from "@agent-chat-platform/auth";
import type {
  AgentRuntime,
  AuditEventStore,
  ClientInstanceId,
  ConversationStore,
  UserStore
} from "@agent-chat-platform/core";
import type { AuditRecorder } from "@agent-chat-platform/core";
import type { AuthAdapter } from "@agent-chat-platform/auth";
import type { ClientInstanceConfig } from "@agent-chat-platform/config-schema";
import type { ModelProvider } from "@agent-chat-platform/model-provider";
import type { ModelUsageGovernance } from "@agent-chat-platform/usage-governance";

export interface ChatServerOptions {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  authAdapter: AuthAdapter;
  conversationStore: ConversationStore;
  auditEventStore: AuditEventStore;
  userStore: UserStore;
  usageGovernance: ModelUsageGovernance;
  auditRecorder: AuditRecorder;
  agentRuntime: AgentRuntime;
  modelProvider: ModelProvider;
  corsOrigin?: string | string[];
  standaloneAuth?: Pick<StandaloneAuthRuntime, "handleRequest" | "baseUrl" | "setPassword">;
  sessionToken?: {
    issuer: HmacSessionTokenIssuer;
    serverCredential: string;
  };
}
