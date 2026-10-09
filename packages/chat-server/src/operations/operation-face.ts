import {
  isRegisteredOperation,
  operationPathParamNames,
  type Operation
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  createOperationRegistry,
  isAppError,
  isAppErrorCode,
  operationDenialError,
  type AuthenticatedIdentity,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationChangeClass,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationOrigin,
  type OperationRegistry,
  type OperationResource,
  type PolicyValue,
  type StorePage
} from "@vivd-catalyst/core";
import { runOperation, type RunOperationDeps } from "@vivd-catalyst/tool-execution";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { checkResponse } from "../http/check-response";
import { paginate, pageScope, storePage } from "../http/paging";
import type { ResolvedChatServerOptions } from "../types";
import { createAuditingEventEmitter } from "./event-emitter";
import { operationRunHref, toOperationRunResource } from "./operation-run-resource";

/**
 * How long a call may run where its operation names no time of its own. A run still running
 * after it counts as interrupted and is failed with the code `interrupted`.
 */
const DEFAULT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

type OperationFaceOptions = Pick<
  ResolvedChatServerOptions,
  | "clientInstanceId"
  | "stores"
  | "auditRecorder"
  | "authorizer"
  | "config"
  | "logger"
  | "operations"
>;

/** What an implementation knows about the call, with the page of a list operation. */
export type OperationBindingContext = OperationExecutionContext & {
  paging: StorePage | undefined;
};

/** What a registration adds to the descriptor of the API contract, before types narrow it. */
export interface AssembledOperationBinding {
  changeClass?: OperationChangeClass;
  /** The release's own policy value. Without one the instance default of the effect applies. */
  defaultPolicy?: PolicyValue;
  events?: OperationDefinition["events"];
  module?: string;
  timeoutMs?: number;
  /**
   * Decides who may call an operation whose descriptor requires no right, from the parsed
   * input and the caller's rights. It is asked where a named right is: before the policy, the
   * guardrails and an approval. Such an operation must have one, and no other may.
   */
  authorize?(
    input: unknown,
    context: OperationAuthorizeContext
  ): OperationAuthorization | Promise<OperationAuthorization>;
  /** What the call touches: what the right is checked on and the subject of its events. */
  resource?(input: unknown): OperationResource | undefined;
  execute(input: unknown, context: OperationBindingContext): unknown;
}

export interface OperationFace {
  readonly registry: OperationRegistry;
  register(operation: Operation, binding: AssembledOperationBinding): void;
  /** Runs one call and answers as the outcome's class says. Returns the body to send. */
  answer(
    operation: Operation,
    call: {
      identity: AuthenticatedIdentity;
      origin: OperationOrigin;
      correlationId: string;
      input: Record<string, unknown>;
      idempotencyKey: string | undefined;
    },
    reply: FastifyReply
  ): Promise<unknown>;
}

const recordSchema = z.record(z.string(), z.unknown());
const runReferenceSchema = z.object({ operationRunId: z.string() });

/**
 * The HTTP face of the operation registry. An operation registered here is reached through
 * `runOperation`, so every call of it is an Operation Run, and the status of the answer says
 * how the run went: `200` with the output, `202` with the run while it waits for an approval,
 * `403` for a refusal, the operation's own error for a failure.
 */
export function createOperationFace(options: OperationFaceOptions): OperationFace {
  const registry = createOperationRegistry();
  const deps: RunOperationDeps = {
    clientInstanceId: options.clientInstanceId,
    registry,
    runs: options.stores.operationRuns,
    authorizer: options.authorizer,
    events: options.operations?.events ?? createAuditingEventEmitter(options.auditRecorder),
    audit: options.auditRecorder,
    policy: {
      instanceDefaults: options.config.policy.defaults,
      centralSettings: () => options.operations?.centralPolicySettings?.() ?? []
    },
    approvals: options.operations?.approvals,
    logger: options.logger,
    now: options.operations?.now
  };

  return {
    registry,
    register(operation, binding) {
      if (!isRegisteredOperation(operation)) {
        throw new Error(`Operation '${operation.id}' is not defined as a registered operation`);
      }
      if (operation.auth !== "user" && operation.auth !== "principal") {
        throw new Error(`Operation '${operation.id}' must authenticate its caller`);
      }
      const { response } = operation;
      if (response.kind !== "json" && response.kind !== "page") {
        throw new Error(`Operation '${operation.id}' must answer JSON`);
      }
      const [action, ...furtherActions] = operation.requires ?? [];
      if (furtherActions.length > 0) {
        throw new Error(`Operation '${operation.id}' may require one right`);
      }
      // Nothing is unchecked by omission: either the registry checks the right the descriptor
      // names, or the registration brings the check.
      const { authorize } = binding;
      if (action !== undefined && authorize !== undefined) {
        throw new Error(
          `Operation '${operation.id}' requires '${action}' and may not check rights itself too`
        );
      }
      const rights =
        action !== undefined
          ? { action }
          : authorize !== undefined
            ? { action: null, authorize }
            : undefined;
      if (!rights) {
        throw new Error(
          `Operation '${operation.id}' requires no right and has no check of its own`
        );
      }
      const page =
        response.kind === "page"
          ? { order: response.order, descending: response.descending }
          : undefined;
      registry.register({
        name: operation.id,
        effect: operation.effect,
        changeClass: binding.changeClass,
        defaultPolicy: binding.defaultPolicy,
        ...rights,
        scope: operation.scope ?? null,
        auth: operation.auth,
        inputSchema: operationInputSchema(operation),
        outputSchema: response.schema,
        resource: (input) => binding.resource?.(input),
        events: binding.events,
        http: { method: operation.method, path: operation.path },
        timeoutMs: binding.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        module: binding.module,
        async execute(input, context) {
          if (!page) {
            return binding.execute(input, { ...context, paging: undefined });
          }
          // A list operation returns its rows and the face cuts the page, as for every list.
          const query = recordSchema.parse(input);
          const scope = pageScope(operation.id, {}, query);
          const rows = await binding.execute(input, {
            ...context,
            paging: storePage(query, page.order, scope)
          });
          return paginate(
            z.array(z.unknown()).parse(rows),
            query,
            page.order,
            page.descending,
            scope
          );
        }
      });
    },
    async answer(operation, call, reply) {
      const outcome = await runOperation(
        {
          operation: operation.id,
          effect: operation.effect,
          input: call.input,
          actor: call.identity,
          origin: call.origin,
          idempotencyKey: call.idempotencyKey,
          correlationId: call.correlationId
        },
        deps
      ).catch((error: unknown) => {
        // A repeated call that cannot be answered still names the run that holds its key.
        const run = isAppError(error) ? runReferenceSchema.safeParse(error.details) : undefined;
        if (run?.success) void reply.header("operation-run-id", run.data.operationRunId);
        throw error;
      });
      const { result, run } = outcome;
      void reply.header("operation-run-id", run.id);
      if (outcome.replayed) void reply.header("idempotent-replayed", "true");
      switch (result.status) {
        case "done":
          if (operation.response.kind === "json" || operation.response.kind === "page") {
            checkResponse(options, operation, operation.response.schema, result.output);
          }
          return result.output;
        case "pending_approval":
          void reply.status(202).header("location", operationRunHref(run));
          return toOperationRunResource(run);
        case "denied":
          throw operationDenialError(result.reason);
        case "failed":
          // The run recorded what the error envelope lets out, so this tells nothing more.
          throw isAppErrorCode(result.error.code)
            ? new AppError(result.error.code, result.error.message, result.error.details)
            : new AppError("INTERNAL", "The operation failed");
        case "expired":
          throw new AppError(
            "OPERATION_EXPIRED",
            "The call expired before it was approved. Call again with a new Idempotency-Key.",
            { operationRunId: run.id }
          );
        case "pending_confirmation":
          throw new AppError("INTERNAL", "A direct call cannot wait for a confirmation");
      }
    }
  };
}

/**
 * One flat input for every surface: the fields of the body, the query and the path. Two parts
 * that name the same field would hide one of them, so that is refused at registration.
 */
function operationInputSchema(operation: Operation): z.ZodType {
  if (operation.body && !(operation.body instanceof z.ZodObject)) {
    throw new Error(`The body of operation '${operation.id}' must be an object`);
  }
  const parts: Record<string, z.ZodType>[] = [
    operation.body?.shape ?? {},
    operation.query?.shape ?? {},
    Object.fromEntries(operationPathParamNames(operation.path).map((name) => [name, z.string()]))
  ];
  const shape: Record<string, z.ZodType> = {};
  for (const [name, schema] of parts.flatMap((part) => Object.entries(part))) {
    if (name in shape) {
      throw new Error(`Operation '${operation.id}' names the input field '${name}' twice`);
    }
    shape[name] = schema;
  }
  return z.object(shape);
}
