import type { AUTH_PRINCIPAL_KINDS } from "@work-shape/catalyst-asset-schemas";
import type { DelegatedActor, UserRole } from "./identity";
import type { ApiCredentialId } from "./ids";

// The actor of an audit record, in a module of its own: what names an actor does not need the
// audit store or the events it records.

export interface AuditActor {
  userId?: string;
  externalUserId?: string;
  displayLabel: string;
  roles: UserRole[];
  principalKind?: (typeof AUTH_PRINCIPAL_KINDS)[number];
  principalId?: string;
  principalDisplayLabel?: string;
  credentialId?: ApiCredentialId;
  subjectUserId?: string;
  delegatedActor?: DelegatedActor;
}
