import type { z } from "zod";
import type { OperationDenial } from "./operation-denial";
import type { AuditRecorder } from "./audit";
import { AppError } from "./errors";
import type { PlatformEventName } from "./events";
import type { AuthenticatedIdentity, OperationScope } from "./identity";
import type { CollaborationWorkspaceId, OperationRunId } from "./ids";
import type { PolicyTarget } from "./operation-policy";
import type { OperationEffect, OperationOrigin, PolicyValue } from "./operations";
import type { AccessResource, ActorAccess } from "./permissions";

/** How far a changing operation reaches. One that declares none counts as `irreversible`. */
export type OperationChangeClass = "reversible" | "irreversible" | "outward";

/**
 * What a call touches, taken from its validated input. It is what the rights are checked on
 * and the subject of the call's events.
 */
export interface OperationResource extends AccessResource {
  kind: string;
  id: string;
  workspaceId?: CollaborationWorkspaceId;
}

/** What an operation's implementation knows about the call it serves. */
export interface OperationExecutionContext {
  runId: OperationRunId;
  actor: AuthenticatedIdentity;
  origin: OperationOrigin;
  workspaceId?: CollaborationWorkspaceId;
  correlationId: string;
  /** The actor's rights, for an operation whose rule is more than one action. */
  access: ActorAccess;
  /** Writes audit rows that carry the run's id and correlation id. */
  audit: AuditRecorder;
}

/** What an operation's own check of the caller's right answers. A refusal names the right. */
export type OperationAuthorization =
  | { allowed: true }
  | ({ allowed: false } & Omit<Extract<OperationDenial, { kind: "forbidden" }>, "kind">);

/** What an operation's own check of the caller's right knows about the call. */
export interface OperationAuthorizeContext {
  actor: AuthenticatedIdentity;
  origin: OperationOrigin;
  workspaceId?: CollaborationWorkspaceId;
  correlationId: string;
  access: ActorAccess;
  resource: OperationResource | undefined;
}

/**
 * Who may call. Either one right the actor needs on the resource, or, where the rule is not
 * one action, the operation's own check. Both are asked at the same place of the call: after
 * the scope and before the policy, the guardrails and an approval. No operation has neither.
 */
type OperationRightsCheck<Input> =
  | { action: string; authorize?: never }
  | {
      action: null;
      authorize(
        input: Input,
        context: OperationAuthorizeContext
      ): OperationAuthorization | Promise<OperationAuthorization>;
    };

/** An operation as it is registered once and reached from every surface. */
export type OperationDefinition<Input = unknown, Output = unknown> = OperationDefinitionBase<
  Input,
  Output
> &
  OperationRightsCheck<Input>;

/**
 * Refuses an operation nobody checks the caller's right for. The types refuse it already; this
 * stops one that reached the registry around them, from a release or from a source.
 */
export function assertOperationChecksRights(definition: OperationDefinition): void {
  const check: { action: unknown; authorize?: unknown } = definition;
  const named = typeof check.action === "string" && check.action.length > 0;
  const own = typeof check.authorize === "function";
  if (named === own) {
    throw new AppError(
      "INTERNAL",
      named
        ? `Operation '${definition.name}' names a right and may not check rights itself too`
        : `Operation '${definition.name}' names no right and has no check of its own`
    );
  }
}

interface OperationDefinitionBase<Input, Output> {
  /** `<resource>.<verb>`. Over HTTP it is the operation id of the API contract. */
  name: string;
  effect: OperationEffect;
  changeClass?: OperationChangeClass;
  /** The release's own policy value. Without one the instance default of the effect applies. */
  defaultPolicy?: PolicyValue;
  /** The scope a credential must carry; `null` asks for none. Checked where a credential arrives. */
  scope: OperationScope | null;
  /** `user` refuses service principals. */
  auth: "user" | "principal";
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType;
  resource(input: Input): OperationResource | undefined;
  /**
   * What the policy is asked about, where the resource does not say it all: the Namespace of
   * an asset, or every asset of a batch. It is asked after the caller's right. Without it the
   * policy is asked about the resource.
   */
  policyTargets?(input: Input): readonly PolicyTarget[] | Promise<readonly PolicyTarget[]>;
  /** The operation's own events, emitted beside the ones every call has. */
  events?: { before?: PlatformEventName; after?: PlatformEventName };
  http: { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string };
  /** A run still `running` after this long counts as interrupted. */
  timeoutMs: number;
  /** The module the operation belongs to. MD-1 reads it; nothing does before. */
  module?: string;
  execute(input: Input, context: OperationExecutionContext): Promise<Output>;
}

/** Which operations a listing asks for. */
export interface OperationListScope {
  workspaceId?: CollaborationWorkspaceId;
}

/**
 * Contributes operations that exist as data: a connection its operations, an app its named
 * actions, a workflow its start.
 */
export interface OperationSource {
  resolve(name: string): Promise<OperationDefinition | undefined>;
  list(scope: OperationListScope): Promise<OperationDefinition[]>;
}

export interface OperationRegistry {
  /** Registers an operation of the release. A name is registered once. */
  register<Input, Output>(definition: OperationDefinition<Input, Output>): void;
  addSource(source: OperationSource): void;
  resolve(name: string): Promise<OperationDefinition | undefined>;
  list(scope?: OperationListScope): Promise<OperationDefinition[]>;
}

export function createOperationRegistry(): OperationRegistry {
  const registered = new Map<string, OperationDefinition>();
  const sources: OperationSource[] = [];
  return {
    register(definition) {
      if (registered.has(definition.name)) {
        throw new AppError("INTERNAL", `Operation '${definition.name}' is registered twice`);
      }
      assertOperationChecksRights(definition);
      registered.set(definition.name, definition);
    },
    addSource(source) {
      sources.push(source);
    },
    async resolve(name) {
      const definition = registered.get(name);
      if (definition) return definition;
      for (const source of sources) {
        const contributed = await source.resolve(name);
        if (contributed) return contributed;
      }
      return undefined;
    },
    async list(scope = {}) {
      const contributed = await Promise.all(sources.map((source) => source.list(scope)));
      return [...registered.values(), ...contributed.flat()];
    }
  };
}
