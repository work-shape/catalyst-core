import type { z } from "zod";
import type { AuditRecorder } from "./audit";
import { AppError } from "./errors";
import type { PlatformEventName } from "./events";
import type { AuthenticatedIdentity, OperationScope } from "./identity";
import type { CollaborationWorkspaceId, OperationRunId } from "./ids";
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

/** An operation as it is registered once and reached from every surface. */
export interface OperationDefinition<Input = unknown, Output = unknown> {
  /** `<resource>.<verb>`. Over HTTP it is the operation id of the API contract. */
  name: string;
  effect: OperationEffect;
  changeClass?: OperationChangeClass;
  /** The release's own policy value. Without one the instance default of the effect applies. */
  defaultPolicy?: PolicyValue;
  /**
   * The right the actor needs on the resource. `null` where the rule is not one action: the
   * implementation then decides through `context.access` who may call.
   */
  action: string | null;
  /** The scope a credential must carry; `null` asks for none. Checked where a credential arrives. */
  scope: OperationScope | null;
  /** `user` refuses service principals. */
  auth: "user" | "principal";
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType;
  resource(input: Input): OperationResource | undefined;
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
