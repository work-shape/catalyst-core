import type { z } from "zod";
import type { OperationDenial } from "./operation-denial";
import type { AuditRecorder } from "./audit";
import { PAGE_ACTION_OPERATION_PREFIX } from "./app-actions";
import { DATA_STORE_OPERATION_PREFIX } from "./data-stores";
import { KNOWLEDGE_OPERATION_PREFIX } from "./knowledge";
import { dataToolPrefixOf } from "./data-tool-names";
import { AppError } from "./errors";
import type { PlatformEventName } from "./events";
import type { OperationBeforeEvent } from "./guardrail-events";
import type { AuthenticatedIdentity, OperationScope } from "./identity";
import type { CollaborationWorkspaceId, OperationRunId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { PolicyTarget } from "./operation-policy";
import type {
  OperationCallRuntime,
  OperationEffect,
  OperationOrigin,
  PolicyValue
} from "./operations";
import type { OperationRunUsage } from "./operation-runs";
import type { AccessResource, ActorAccess } from "./permissions";
import type { ToolHandlerResult } from "./tool-execution";
import { WORKFLOW_OPERATION_PREFIX } from "./workflows";

/**
 * How an operation whose work outlives its call ends (`completion` of the definition). The
 * call starts the work and answers its Operation Run at once, in status `running`; whoever
 * carries the work out ends that run later, with the result as its output, through
 * `OperationRunStore.finish`. A Workflow step that calls such an operation waits for that end
 * holding no step slot. The work belongs to its owner, not to the caller: a step that stops
 * waiting leaves it running.
 */
export interface OperationAsyncCompletion {
  mode: "async";
  /**
   * The sentence a run page shows where a step stopped waiting while the work goes on, in
   * the words of the operation's owner, such as "Abgleich läuft weiter".
   */
  stillRunning: string;
  /** The result a simulated call of a test run answers in place of the real one. */
  example: JsonValue;
}

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
/** Who decides a call that waits for an approval: see `approval` of the definition. */
export interface OperationApproval {
  /** The kind of the approval request, such as `app_publish`. */
  kind: string;
  /** The instance-level right that decides it, such as `app.approve`. */
  action: string;
  /**
   * What the request is about, frozen when it is filed, such as the revision a publish makes
   * live and the live one then. The request's kind reads it to show it and to tell whether
   * it moved.
   */
  subject?: JsonObject;
}

export interface OperationExecutionContext {
  /** An async start that found existing work returns its canonical run. The candidate call
   * is settled with only that run id; it never becomes a second owner of the work. */
  joinAsyncRun?(runId: OperationRunId): void;
  runId: OperationRunId;
  actor: AuthenticatedIdentity;
  origin: OperationOrigin;
  workspaceId?: CollaborationWorkspaceId;
  correlationId: string;
  /**
   * The idempotency key of the call, where it has one. An operation that sets
   * `repeatsUnderKey` hands it to whatever carries the call out.
   */
  idempotencyKey?: string;
  /** What only the live call has. Empty for a call that is executed after an approval. */
  runtime: OperationCallRuntime;
  /** The actor's rights, for an operation whose rule is more than one action. */
  access: ActorAccess;
  /** Writes audit rows that carry the run's id and correlation id. */
  audit: AuditRecorder;
  /**
   * Set where an App action hands the call on to the operation it stands for, whoever called
   * the action: a frame, an agent that carries it as a tool, or anything else. The App action
   * sets it when it executes; no caller does.
   */
  byAppAction?: true;
  /**
   * The events of the operation's own `beforeEvents` as they were asked for this call, just
   * before it executes: a call that waited for an approval is asked again first. An operation
   * whose subject can change between the check and the write, such as the newest revision of
   * a Page, writes what their guardrails read.
   */
  beforeEvents?: readonly OperationBeforeEvent[];
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

/**
 * Refuses a changing operation that carries the mark of a read. A changing call is always
 * recorded, so the mark on one says nothing and would read as if it could be left off.
 */
export function assertOperationRecordingMark(definition: OperationDefinition): void {
  if (definition.recordsEveryCall !== undefined && definition.effect !== "reading") {
    throw new AppError(
      "INTERNAL",
      `Operation '${definition.name}' is changing and is always recorded: remove 'recordsEveryCall'`
    );
  }
}

/**
 * Refuses an operation whose answer holds a secret and whose own policy holds it for an
 * approval: the two cannot both be meant, so the release does not start with it.
 */
export function assertSecretOperationIsNotHeld(
  definition: Pick<OperationDefinition, "name" | "secret" | "defaultPolicy">
): void {
  if (definition.secret && definition.defaultPolicy === "approval") {
    throw new AppError(
      "INTERNAL",
      `Operation '${definition.name}' answers a secret and cannot wait for an approval`
    );
  }
}

/**
 * Whether an allowed call that completes leaves an Operation Run and audit rows. Decided from
 * the definition alone, never from the caller.
 */
export function recordsAllowedCalls(
  definition: Pick<OperationDefinition, "effect" | "recordsEveryCall">
): boolean {
  return definition.effect === "changing" || definition.recordsEveryCall === true;
}

interface OperationDefinitionBase<Input, Output> {
  /** `<resource>.<verb>`. Over HTTP it is the operation id of the API contract. */
  name: string;
  effect: OperationEffect;
  /**
   * Set on a reading operation whose every call is recorded. Without it an allowed read that
   * completes leaves no Operation Run and no audit row, and a read is recorded only when it is
   * refused or fails. Rights, policy and guardrails are asked for every read either way.
   * An operation that reads a customer's data through a Connection, a Knowledge Base or a Data
   * Store sets it, and so does every agent tool. A changing operation is always recorded and
   * may not carry it.
   */
  recordsEveryCall?: true;
  /**
   * The operation can hand its rows over through a cursor, so a Workflow step that names
   * `dataset` reads its whole result into a dataset instead of ending at a row cap, and it is
   * not paged. Reserved: the slice that brings datasets reads it.
   */
  streams?: true;
  /** How this accepted reading Connection operation pages. */
  paging?: import("@work-shape/catalyst-asset-schemas").OperationPaging;
  changeClass?: OperationChangeClass;
  /**
   * Set on a changing operation whose call may be made again under the key of a call that was
   * interrupted: what carries the call out is handed the key (`idempotencyKey` of the
   * execution context) and carries out one call per key, so a second call under it changes
   * nothing more. An interrupted run of such an operation is run again under its key, where
   * every other interrupted changing call is never made a second time. An operation of a
   * Connection sets it where its entry names the header that carries the key to the outside
   * system.
   */
  repeatsUnderKey?: true;
  /**
   * Set on a changing operation that starts work which ends after the call, such as the sync
   * of a Knowledge Base's source. Its `execute` starts the work and answers once it is
   * started; what it answers is not kept. Its run stays `running` until the work ends, so its
   * `timeoutMs` is how long the work may take before the run counts as interrupted.
   */
  completion?: OperationAsyncCompletion;
  /** Takes items or a dataset and answers OperationBatchResult. Per-item failures do not fail the call.
   * Failure messages name only the invalid field and code, never item values or provider text. */
  batch?: true;
  /** A Workflow start called by a draft starts a test run of its published revision. */
  draftTarget?: "test";
  /** The release's own policy value. Without one the instance default of the effect applies. */
  defaultPolicy?: PolicyValue;
  /**
   * A value no call of the operation is looser than, whatever a central setting says. See
   * `policyFloor` of the policy's input.
   */
  policyFloor?: PolicyValue;
  /**
   * A floor of one call, where it depends on where the call came from and not on the operation
   * alone: a tool an agent is given for the subject of its conversation stands for an operation
   * on that asset. Asked with the policy, and again before a call that waited is executed. The
   * stricter of it and `policyFloor` holds. It is told the call's input, which can name the
   * asset the call writes.
   */
  policyFloorOf?(
    origin: OperationOrigin,
    input: unknown
  ): PolicyValue | undefined | Promise<PolicyValue | undefined>;
  /**
   * Who decides a call of the operation that waits for an approval, where it is not every
   * holder of `operations.approve`: the kind its request is filed as, which the approvers'
   * Inbox lists, and the instance-level right that decides it. A caller who holds that right
   * answers a guardrail's `require_approval` with their own click in the interface: the run
   * records them as caller and as approver, and no request is filed. CLI calls never do this.
   */
  approval?(input: unknown): OperationApproval | undefined | Promise<OperationApproval | undefined>;
  /**
   * The answer holds a secret that is shown once, such as a new key. The run keeps no output,
   * so a repeated call with the same key answers OUTPUT_NOT_RETAINED and never the secret
   * again. The call is never held for an approval: a held call is executed later, when nobody
   * is there to be shown the answer.
   */
  secret?: true;
  /**
   * Set by an operation whose input can hold a secret, such as a password. For a call that
   * holds one it answers the input with the secret replaced by a fixed mark; for a call that
   * holds none it answers nothing. The run's hash of such a call is taken over what this
   * answers: the hash is kept and shown with the run, and a fast hash of a password can be
   * guessed. Such a call is treated as one that answers a secret: it keeps no answer and is
   * never held for an approval, since a held call keeps its input and shows it to whoever
   * decides.
   */
  inputWithoutSecrets?(input: Input): unknown;
  /** The scope a credential must carry; `null` asks for none. Checked where a credential arrives. */
  scope: OperationScope | null;
  /** `user` refuses service principals. */
  auth: "user" | "principal";
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType;
  /**
   * The input and the output as JSON Schema, where the operation was described by one: an
   * operation of a Connection carries what its outside system listed. A reader that shows an
   * operation to a person or a model takes these before it derives one from `inputSchema`.
   */
  inputJsonSchema?: JsonObject;
  outputJsonSchema?: JsonObject;
  resource(input: Input): OperationResource | undefined;
  /**
   * What the policy is asked about, where the resource does not say it all: the Namespace of
   * an asset, or every asset of a batch. It is asked after the caller's right. Without it the
   * policy is asked about the resource.
   */
  policyTargets?(input: Input): readonly PolicyTarget[] | Promise<readonly PolicyTarget[]>;
  /** The operation's own events, emitted beside the ones every call has. */
  events?: { before?: PlatformEventName; after?: PlatformEventName };
  /**
   * The before-events of a call beside `operation.before_call`, one per subject it writes or
   * makes live: a write of assets names `asset.before_write` for each asset. The guardrails of
   * each read the fields it hands them. Asked after the caller's right, with the policy.
   */
  beforeEvents?(
    input: Input,
    origin: OperationOrigin
  ): readonly OperationBeforeEvent[] | Promise<readonly OperationBeforeEvent[]>;
  /**
   * The input fields the `heldInput` of its before-events may set for a call held for an
   * approval, such as the revision of a Page it copies. They are merged into the input when the
   * call is executed; no other field of the input can be changed that way.
   */
  heldInputKeys?: readonly string[];
  /** Where the operation is reached over HTTP. An agent tool has no such face. */
  http?: { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string };
  /** A run still `running` after this long counts as interrupted. */
  timeoutMs: number;
  /** The module the operation belongs to. MD-1 reads it; nothing does before. */
  module?: string;
  execute(
    input: Input,
    context: OperationExecutionContext
  ): Promise<Output | ToolOperationAnswer<Output>>;
}

const toolOperationAnswer: unique symbol = Symbol("toolOperationAnswer");

/**
 * What an operation that is an agent tool answers: the tool's whole result, with what the
 * agent is shown beside the output and with a failure the tool reports itself. The call path
 * records the run from it and hands it to the agent unchanged.
 */
export interface ToolOperationAnswer<Output = unknown> {
  readonly [toolOperationAnswer]: true;
  readonly result: ToolHandlerResult<Output>;
  /** What the model calls the tool made used, summed. The run keeps it. */
  readonly usage?: OperationRunUsage;
}

export function answerAsTool<Output>(
  result: ToolHandlerResult<Output>,
  usage?: OperationRunUsage
): ToolOperationAnswer<Output> {
  return { [toolOperationAnswer]: true, result, usage };
}

export function isToolOperationAnswer(answer: unknown): answer is ToolOperationAnswer {
  return typeof answer === "object" && answer !== null && toolOperationAnswer in answer;
}

/**
 * The action a refusal names when an agent calls a tool its definition does not list:
 * `agent_tool:<tool name>`. No grant carries it; it exists so the refusal says what was asked.
 */
export const AGENT_TOOL_ACTION_PREFIX = "agent_tool:";

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
  /**
   * Of the named operations, those the source has, with one read per thing they belong to
   * and never one per name. A source without it is asked for each name.
   */
  resolveMany?(names: readonly string[]): Promise<OperationDefinition[]>;
  list(scope: OperationListScope): Promise<OperationListing>;
}

/** A source reads at most so much for one listing, and more than that exists. */
export interface OperationListTruncation {
  /** The name prefix of the operations of which some are left out. */
  prefix: string;
  /** How many of what the source counts one listing reads. */
  limit: number;
  /** The constant that sets the limit, as an operator finds it. */
  limitName: string;
}

/**
 * The operations of a listing, and what it leaves out. A source that reads a bounded number
 * of rows never leaves operations out silently: it names itself in `truncated`.
 */
export interface OperationListing {
  operations: OperationDefinition[];
  /** One entry per source that left operations out. Empty where the listing is whole. */
  truncated: OperationListTruncation[];
}

export interface OperationRegistry {
  /** Registers an operation of the release. A name is registered once. */
  register<Input, Output>(definition: OperationDefinition<Input, Output>): void;
  addSource(source: OperationSource): void;
  resolve(name: string): Promise<OperationDefinition | undefined>;
  /**
   * Several operations by name, as `resolve` would answer each. A name nothing has is left
   * out. A source that can reads what several names share once.
   */
  resolveMany(names: readonly string[]): Promise<Map<string, OperationDefinition>>;
  list(scope?: OperationListScope): Promise<OperationListing>;
}

/**
 * The name prefixes of operations that exist as data and come from an `OperationSource`: the
 * operations of a Connection, `connection.<name>.<operation>`, and the named actions of an
 * App, `app.<id>.<action>`. An operation of the release may
 * not take such a name. `resolve` asks the release first, so one that did would stand in for
 * the data operation of that name, with rights and a policy of its own. They are the prefixes
 * of the data tools, `dataToolPrefixOf`. The names a Page's actions run as,
 * `page_action.<page id>.<action>`, are kept from the release in the same way: they are no
 * data tool, since no source resolves them and no agent carries them.
 */

/**
 * The prefixes of the operations of one Workflow, one Data Store and one Knowledge Base:
 * `<prefix><id>.<verb>`. They come from an `OperationSource` too. A name of that form is kept
 * from the release. A name of two parts under the same prefix is not, so the one tool
 * `knowledge.query` registers, and so does every plural name such as `workflows.test`.
 */
export const SOURCED_OPERATION_PREFIXES = [
  WORKFLOW_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX
] as const;

/** The prefix whose sources the name belongs to, where a registered operation may not take it. */
function sourcePrefixOf(name: string): string | undefined {
  return (
    dataToolPrefixOf(name) ??
    (name.startsWith(PAGE_ACTION_OPERATION_PREFIX) ? PAGE_ACTION_OPERATION_PREFIX : undefined) ??
    SOURCED_OPERATION_PREFIXES.find(
      (prefix) => name.startsWith(prefix) && name.indexOf(".", prefix.length) > 0
    )
  );
}

export function createOperationRegistry(): OperationRegistry {
  const registered = new Map<string, OperationDefinition>();
  const sources: OperationSource[] = [];
  return {
    register(definition) {
      const dataPrefix = sourcePrefixOf(definition.name);
      if (dataPrefix !== undefined) {
        throw new AppError(
          "INTERNAL",
          `Operation '${definition.name}' starts with '${dataPrefix}', which names operations that come from data. Register it under another name.`
        );
      }
      if (registered.has(definition.name)) {
        throw new AppError("INTERNAL", `Operation '${definition.name}' is registered twice`);
      }
      assertOperationChecksRights(definition);
      assertOperationRecordingMark(definition);
      assertSecretOperationIsNotHeld(definition);
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
    async resolveMany(names) {
      const found = new Map<string, OperationDefinition>();
      let open = [...new Set(names)];
      for (const name of open) {
        const definition = registered.get(name);
        if (definition) found.set(name, definition);
      }
      for (const source of sources) {
        open = open.filter((name) => !found.has(name));
        if (open.length === 0) break;
        const asked = open;
        const contributed = source.resolveMany
          ? await source.resolveMany(asked)
          : (await Promise.all(asked.map((name) => source.resolve(name)))).flatMap(
              (definition) => definition ?? []
            );
        for (const definition of contributed) {
          // A source is never trusted to answer a name it was not asked for.
          if (asked.includes(definition.name) && !found.has(definition.name)) {
            found.set(definition.name, definition);
          }
        }
      }
      return found;
    },
    async list(scope = {}) {
      const contributed = await Promise.all(sources.map((source) => source.list(scope)));
      return {
        operations: [
          ...registered.values(),
          ...contributed.flatMap((listing) => listing.operations)
        ],
        truncated: contributed.flatMap((listing) => listing.truncated)
      };
    }
  };
}

export {
  operationBatchResultSchema,
  operationBatchFailureSchema,
  type OperationBatchResult,
  type OperationBatchFailure
} from "@work-shape/catalyst-asset-schemas";
