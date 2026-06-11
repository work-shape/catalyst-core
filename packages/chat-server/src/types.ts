import type { HmacSessionTokenIssuer, StandaloneAuthRuntime } from "@vivd-stage/auth";
import type {
  AgentRuntime,
  AuditEventStore,
  ClientInstanceId,
  ConversationStore,
  UserStore
} from "@vivd-stage/core";
import type { AuditRecorder } from "@vivd-stage/core";
import type { AuthAdapter } from "@vivd-stage/auth";
import type { ClientInstanceConfig } from "@vivd-stage/config-schema";
import type { ModelProvider } from "@vivd-stage/model-provider";
import type { ModelUsageGovernance } from "@vivd-stage/usage-governance";

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
  standaloneAuth?: Pick<
    StandaloneAuthRuntime,
    "handleRequest" | "baseUrl" | "setPassword" | "changePassword"
  >;
  sessionToken?: {
    issuer: HmacSessionTokenIssuer;
    serverCredential: string;
  };
}
