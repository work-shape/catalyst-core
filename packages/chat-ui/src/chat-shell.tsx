import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  ApiUser,
  AuditEvent,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest,
  UsageSummary
} from "@vivd-catalyst/api-client";
import { ChatWorkspace } from "./chat-workspace";

export interface ChatShellAdminPanel {
  canView(user: ApiUser | undefined): boolean;
  renderPanel(input: {
    usage: UsageSummary | undefined;
    auditEvents: AuditEvent[];
    users: AdministeredUser[];
    loading: boolean;
    usersLoading: boolean;
    error?: string;
    usersError?: string;
    usersMutating: boolean;
    onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
    onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
    onUpsertUserIdentity(
      userId: string,
      input: UpsertAdministeredUserIdentityRequest
    ): Promise<AdministeredUser>;
    onDeleteUserIdentity(
      userId: string,
      identity: AdministeredUserIdentity
    ): Promise<AdministeredUser>;
    onResetUserPassword(userId: string, password: string): Promise<unknown>;
  }): ReactNode;
}

export interface ChatShellProps {
  apiBaseUrl: string;
  token?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  adminPanel?: ChatShellAdminPanel;
  manageDocumentTitle?: boolean;
  className?: string;
}

export function ChatShell(props: ChatShellProps) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ChatWorkspace {...props} />
    </QueryClientProvider>
  );
}
