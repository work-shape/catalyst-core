import {
  AUTH_PRINCIPAL_KINDS,
  AUTH_SCOPE_WILDCARD,
  CHAT_SESSION_AUTH_SCOPES,
  FIRST_PARTY_AUTH_SCOPES,
  type ChatSessionAuthScope,
  type FirstPartyAuthScope,
  type OperationScope
} from "@work-shape/catalyst-asset-schemas";
import { AppError } from "./errors";
import type {
  AgentRunId,
  ApiCredentialId,
  ClientInstanceId,
  ServicePrincipalId,
  WorkflowRunId
} from "./ids";
import type { JobId } from "./jobs";
import type { LocaleCode } from "./localization";

export type UserRole = "user" | "admin" | "superadmin" | string;

export {
  AUTH_SCOPE_WILDCARD,
  CHAT_SESSION_AUTH_SCOPES,
  FIRST_PARTY_AUTH_SCOPES,
  type ChatSessionAuthScope,
  type FirstPartyAuthScope,
  type OperationScope
};
export type AuthScope = FirstPartyAuthScope | (string & {});

export type AuthPrincipalKind = (typeof AUTH_PRINCIPAL_KINDS)[number];

export interface AuthPrincipal {
  kind: AuthPrincipalKind;
  id: string;
  displayLabel: string;
  clientInstanceId: ClientInstanceId;
  authSource: string;
  externalUserId?: string;
}

/**
 * Who acts for the subject user. `service_principal` is the backend of an embedding host that
 * named the user in a session token. `api_key` is the user's own personal API key: its id is
 * the key's, its label the key's name.
 */
export type DelegatedActor =
  | { kind: "service_principal"; id: string; displayLabel?: string; authSource: string }
  | { kind: "api_key"; id: ApiCredentialId; displayLabel: string; authSource: string };

export interface AuthenticatedUser {
  /** Set by adapters when a browser session cookie authenticated this request. */
  authenticationMethod?: "session-cookie";
  /**
   * The id of the first-party sign-in session that authenticated the request, set with
   * `authenticationMethod: "session-cookie"`. Never the cookie's token.
   */
  sessionId?: string;
  id: string;
  externalUserId: string;
  displayLabel: string;
  email?: string;
  emailVerified?: boolean;
  roles: UserRole[];
  /** Group ids vouched for by the identity adapter; never supplied by an operation caller. */
  groups?: readonly string[];
  permissionRefs: string[];
  permissions?: string[];
  clientInstanceId: ClientInstanceId;
  authSource: string;
  correlationId?: string;
  principal?: AuthPrincipal;
  subjectUserId?: string;
  delegatedActor?: DelegatedActor;
  scopes?: AuthScope[];
  /**
   * The scopes of the personal API key the call presents, `<action>` or `<action>:<prefix>`.
   * The authorizer allows a right only where the user holds it and one of these covers it, so
   * a key never does more than its owner may now. Absent for a signed-in person.
   */
  keyScopes?: readonly string[];
}

export interface AuthenticatedServicePrincipal {
  kind: "service";
  id: ServicePrincipalId;
  credentialId: ApiCredentialId;
  displayLabel: string;
  permissionRefs: string[];
  permissions: string[];
  clientInstanceId: ClientInstanceId;
  authSource: string;
  correlationId?: string;
  scopes: AuthScope[];
}

/**
 * The service principal a Workflow Run acts as, as the actor of the calls its steps make. No
 * credential authenticated it: the published definition names it under `runAs`, and whoever
 * published that definition held the right to let it act. Its rights are the principal's own,
 * read from its record and its grants like those of a principal that presents a credential.
 *
 * `permissions`, `permissionRefs` and `scopes` are what the principal's record and grants hold
 * when the step runs, and nothing wider. `scopes` restricts as it does for a credential: a run
 * holds the scopes of the rights its principal was granted and never `["*"]`, so a call that
 * needs a scope the principal has no right for is refused before its right is asked.
 */
export interface WorkflowRunPrincipal extends Omit<AuthenticatedServicePrincipal, "credentialId"> {
  workflowRunId: WorkflowRunId;
}

/** A service principal as an actor, whether a credential or a Workflow Run stands behind it. */
export type ActingServicePrincipal = AuthenticatedServicePrincipal | WorkflowRunPrincipal;

export type AuthenticatedIdentity = AuthenticatedUser | ActingServicePrincipal;

/**
 * Whether the caller is a service principal, with a credential or as a Workflow Run. It admits
 * both, and every caller of it was read for that: each one takes "service principal" to mean
 * that no person is present, and then refuses, leaves a user id out or names the actor a
 * service principal. None reads `credentialId` behind it. A run's principal that failed this
 * check would be taken for a person, which is the unsafe side. A place that needs the
 * credential asks for `credentialId` itself.
 */
export function isAuthenticatedServicePrincipal(
  identity: AuthenticatedIdentity
): identity is ActingServicePrincipal {
  return "kind" in identity && identity.kind === "service";
}

/**
 * The hold of one attempt of an `agent_run.execute` job on its run, as a store write names
 * it. A write that carries it is stored only while the job is still running under the token
 * and the run has not ended, in the transaction of the write. Otherwise it throws
 * `JobLeaseLostError` or `CONFLICT` and stores nothing.
 */
export interface AgentRunWriteFence {
  runId: AgentRunId;
  lease: { jobId: JobId; leaseToken: string };
}

/**
 * What a call made by a draft carries (ADR-0031): the draft asset, the revision of it that
 * made the call and the App action or Workflow step that made it. `runOperation()` decides from
 * it where the call goes: a reading call reads live, a changing call is simulated unless "Run
 * live once" was switched on for this action or step of this revision.
 */
export interface OperationDraftContext {
  /** The draft Workflow test that binds a live-once switch across agent tool calls. */
  workflowRunId?: string;
  /** The App or the Workflow whose draft makes the call. */
  asset: { kind: string; id: string; name: string };
  /** The draft revision that made the call. A switch set for another revision does not apply. */
  revisionId: string;
  /** The App action or the Workflow step, by its name. */
  part: string;
  /**
   * A test run of a Workflow draft: the service principal the Workflow runs as. The call is
   * made as the person testing and allowed only where the principal holds the right too.
   */
  boundBy?: ActingServicePrincipal;
  /** Trusted, derived ceiling of a Workflow-owned draft; never supplied by a request. */
  boundRights?: readonly { action: string; assetId: string }[];
  /**
   * A test run whose start was the tester's own confirmation: they called `workflows.test`
   * themselves, or confirmed an agent's call of it. A step's `confirm` is then satisfied by
   * that start, as a person's direct call satisfies it; `approval` still gates the step.
   */
  startConfirmed?: boolean;
}

export interface RuntimeCallContext {
  user: AuthenticatedUser;
  clientInstanceId: ClientInstanceId;
  correlationId: string;
  locale?: LocaleCode;
  principal?: AuthPrincipal;
  subjectUserId?: string;
  delegatedActor?: DelegatedActor;
  scopes?: AuthScope[];
  deadline?: Date;
  /** Executor stops carry an `OperationExecutionStop` reason, distinguishing timeout from caller abort. */
  signal?: AbortSignal;
  /**
   * Present while a claimed Agent Run job makes the call. A tool hands it to the store writes
   * it makes for the run, so a run that lost its lease leaves no such write behind.
   */
  runFence?: AgentRunWriteFence;
  /**
   * Set while a subagent's worker makes the call (CR-1). A subagent never waits for a
   * decision: a call that needs one is refused with `confirmation_required`.
   */
  subagent?: true;
  /** A Workflow agent step: confirmations fail; approvals may pause. */
  workflowAgent?: true;
  /** A Workflow draft test: calls act as the tester, bounded by its principal. */
  workflowDraft?: OperationDraftContext;
  /**
   * Set while the call acts for a person who is not present: a scheduled start of an agent
   * (EW-8). A confirmation it asks for waits in that person's Inbox (OP-4b).
   */
  unattended?: true;
}

export function createUserPrincipal(user: AuthenticatedUser): AuthPrincipal {
  return {
    kind: "user",
    id: user.id,
    externalUserId: user.externalUserId,
    displayLabel: user.displayLabel,
    clientInstanceId: user.clientInstanceId,
    authSource: user.authSource
  };
}

export function normalizeAuthenticatedUser(user: AuthenticatedUser): AuthenticatedUser {
  const subjectUserId = user.subjectUserId ?? user.id;
  const principal =
    user.principal?.kind === "service"
      ? user.principal
      : createUserPrincipal({
          ...user,
          id: subjectUserId
        });

  return {
    ...user,
    subjectUserId,
    principal,
    scopes: user.scopes
  };
}

export function authContextFromUser(
  user: AuthenticatedUser
): Pick<RuntimeCallContext, "principal" | "subjectUserId" | "delegatedActor" | "scopes"> {
  const normalized = normalizeAuthenticatedUser(user);
  return {
    principal: normalized.principal,
    subjectUserId: normalized.subjectUserId,
    delegatedActor: normalized.delegatedActor,
    scopes: normalized.scopes
  };
}

export function getSubjectUserId(user: AuthenticatedUser): string {
  return user.subjectUserId ?? user.id;
}

export function getRuntimeSubjectUserId(context: RuntimeCallContext): string {
  return context.subjectUserId ?? getSubjectUserId(context.user);
}

export function getAuthPrincipal(user: AuthenticatedUser): AuthPrincipal {
  return normalizeAuthenticatedUser(user).principal ?? createUserPrincipal(user);
}

export function getAuthScopes(user: { scopes?: AuthScope[] }): AuthScope[] {
  return user.scopes ?? [AUTH_SCOPE_WILDCARD];
}

export function hasAuthScope(user: { scopes?: AuthScope[] }, scope: AuthScope): boolean {
  const scopes = getAuthScopes(user);
  return scopes.includes(AUTH_SCOPE_WILDCARD) || scopes.includes(scope);
}

export function requireAuthScope(user: { scopes?: AuthScope[] }, scope: AuthScope): void {
  if (!hasAuthScope(user, scope)) {
    throw new AppError("FORBIDDEN", `Missing auth scope '${scope}'`);
  }
}

export function isChatSessionAuthScope(scope: string): scope is ChatSessionAuthScope {
  return CHAT_SESSION_AUTH_SCOPES.includes(scope as ChatSessionAuthScope);
}
