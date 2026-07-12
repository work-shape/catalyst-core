import {
  getAuthPrincipal,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type AuthenticatedServicePrincipal,
  type AuthenticatedUser,
  type DelegatedActor,
  type UserRole
} from "./identity";
import type { ApiCredentialId, AuditEventId, ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

export interface AuditActor {
  userId?: string;
  externalUserId?: string;
  displayLabel: string;
  roles: UserRole[];
  principalKind?: "user" | "service";
  principalId?: string;
  principalDisplayLabel?: string;
  credentialId?: ApiCredentialId;
  subjectUserId?: string;
  delegatedActor?: DelegatedActor;
}

export type AuditEventStatus = "success" | "failed" | "denied";

export interface AuditEvent {
  id: AuditEventId;
  clientInstanceId: ClientInstanceId;
  type: string;
  status: AuditEventStatus;
  actor?: AuditActor;
  subject?: string;
  reason?: string;
  correlationId: string;
  createdAt: ISODateString;
  metadata?: JsonObject;
}

export interface AuditEventInput {
  clientInstanceId: ClientInstanceId;
  type: string;
  status: AuditEventStatus;
  actor?: AuditActor;
  subject?: string;
  reason?: string;
  correlationId: string;
  metadata?: JsonObject;
}

export interface AuditEventStore {
  appendAuditEvent(input: AuditEventInput): Promise<AuditEvent>;
  listAuditEvents(input: {
    clientInstanceId: ClientInstanceId;
    limit?: number;
    type?: string;
  }): Promise<AuditEvent[]>;
}

export interface AuditRecorder {
  record(input: Omit<AuditEventInput, "clientInstanceId">): Promise<AuditEvent>;
}

export class StoreBackedAuditRecorder implements AuditRecorder {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: AuditEventStore;

  constructor(input: { clientInstanceId: ClientInstanceId; store: AuditEventStore }) {
    this.clientInstanceId = input.clientInstanceId;
    this.store = input.store;
  }

  record(input: Omit<AuditEventInput, "clientInstanceId">): Promise<AuditEvent> {
    return this.store.appendAuditEvent({
      ...input,
      clientInstanceId: this.clientInstanceId
    });
  }
}

export class NoopAuditRecorder implements AuditRecorder {
  async record(input: Omit<AuditEventInput, "clientInstanceId">): Promise<AuditEvent> {
    return {
      id: "audit_noop" as AuditEvent["id"],
      clientInstanceId: "noop" as ClientInstanceId,
      type: input.type,
      status: input.status,
      actor: input.actor,
      subject: input.subject,
      reason: input.reason,
      correlationId: input.correlationId,
      createdAt: new Date().toISOString(),
      metadata: input.metadata
    };
  }
}

export function auditActorFromUser(user: AuthenticatedUser): AuditActor {
  const principal = getAuthPrincipal(user);
  return {
    userId: user.id,
    externalUserId: user.externalUserId,
    displayLabel: user.displayLabel,
    roles: user.roles,
    principalKind: principal.kind,
    principalId: principal.id,
    principalDisplayLabel: principal.displayLabel,
    subjectUserId: getSubjectUserId(user),
    delegatedActor: user.delegatedActor
  };
}

export function auditActorFromIdentity(identity: AuthenticatedIdentity): AuditActor {
  if (isAuthenticatedServicePrincipal(identity)) {
    return auditActorFromServicePrincipal(identity);
  }
  return auditActorFromUser(identity);
}

export function auditActorFromServicePrincipal(
  principal: AuthenticatedServicePrincipal
): AuditActor {
  return {
    displayLabel: principal.displayLabel,
    roles: [],
    principalKind: "service",
    principalId: principal.id,
    principalDisplayLabel: principal.displayLabel,
    credentialId: principal.credentialId
  };
}
