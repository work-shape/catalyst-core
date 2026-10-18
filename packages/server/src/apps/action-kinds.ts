import {
  applyAppActionMapping,
  bindSqlActionParameters,
  type CompiledAppAction
} from "@work-shape/catalyst-app-build";
import {
  AppError,
  CONNECTION_ASSET_KIND,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  connectionCallError,
  connectionOperationName,
  dataStoreOperationName,
  dataStoreRefusalError,
  type AppCallTarget,
  type DataStoreReference,
  type JsonObject,
  type ModuleName,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationDefinition,
  type OperationResource
} from "@work-shape/catalyst-core";

import type { RunOperationDeps } from "@work-shape/catalyst-tool-execution";

// What each kind of named action stands for. An action of every kind is one operation of the
// registry, reached through that operation's own definition: a `connection` action an
// operation of a Connection, an `sql` action the query or the insert of a Data Store, a
// `workflow` action the start of a Workflow by hand (`workflows.start`). The
// call path knows this one interface and asks it by the action's kind; nothing else compares
// a kind.
//
// A binding is built by the server from the compiled manifest of a stored revision, and the
// action it belongs to is run with an origin the server made from the frame's checked session.
// Nothing here reads an origin, so no caller gains anything by naming one: an operation that
// is called by its own name asks its own right of its caller, whatever the call says of itself.

/** What a binding reads of the Page or the revision of an App its action belongs to. */
export interface AppActionOwner {
  /** The App. A Page of a conversation is no asset and has none. */
  resource: OperationResource | undefined;
  /** The Data Stores the manifest lists, as `declaredDataStoresOf` reads them. */
  dataStores: readonly DataStoreReference[];
}

/**
 * The refusal of an `sql` action whose store its manifest does not list, or nothing. A stored
 * manifest is what a build answered, and a build is not trusted to have tied the two: the
 * publish and every call ask here, of the same list.
 */
export function unlistedDataStore(
  listed: readonly DataStoreReference[],
  action: ActionOfKind<"sql">
): AppError | undefined {
  return listed.some((store) => store.name === action.dataStore)
    ? undefined
    : dataStoreRefusalError("data_store_not_listed", action.dataStore, { action: action.name });
}

/** What one compiled action stands for, and what is particular to its kind at a call. */
export interface AppActionBinding {
  /** The operation of the registry the action stands for, by name. */
  readonly operation: string;
  /** What a run of the action names as reached. */
  readonly target: AppCallTarget;
  /** The kind of asset the operation belongs to, which a setting of the policy may name. */
  readonly assetKind: string;
  /**
   * The module that brings the operation, where it is one beside `apps`. With that module off
   * the action is refused before the caller's rights are known.
   */
  readonly module?: ModuleName;
  /** The operation as this action may run it for the Page or the revision it belongs to, or why not. */
  admit(
    operation: OperationDefinition | undefined,
    host: AppActionOwner
  ): { operation: OperationDefinition } | { refusal: AppError };
  /**
   * The right on what the action reaches, asked after the right on the App. `host` says
   * whether the action belongs to the published revision of its App.
   */
  authorize(
    operation: OperationDefinition,
    context: OperationAuthorizeContext,
    host: { published: boolean },
    resolveResource: RunOperationDeps["resolveResource"]
  ): OperationAuthorization | Promise<OperationAuthorization>;
  /** The input of the operation, made of the parameters a caller passed. */
  inputOf(parameters: JsonObject): unknown;
  /** What a call fails with where that input does not fit the operation. */
  inputRefusal(): AppError;
  /** What an agent that carries the action as a tool reads, where its author wrote nothing. */
  describe(appTitle: string): string;
  /**
   * What a call in safe mode answers in place of a refusal, made of the parameters a caller
   * passed: what it would have done, as a sentence, and the input it would have done it with.
   * Nothing is called for it. A kind without it is refused in safe mode.
   */
  dryRun?(parameters: JsonObject): { wouldHave: string; input: JsonObject };
}

/**
 * The caller's right on an operation, by that operation's own rule. `input` is what of the
 * operation's input the action fixes, where its rule reads that.
 */
async function authorizeCaller(
  operation: OperationDefinition,
  context: OperationAuthorizeContext,
  resolveResource: RunOperationDeps["resolveResource"],
  input?: JsonObject
): Promise<OperationAuthorization> {
  const { resource, resourceNotFound } = await resolveResource(operation.resource(input));
  if (operation.action !== null) {
    const decision = context.access.authorize(operation.action, resource);
    if (decision.allowed && resourceNotFound) throw new AppError("NOT_FOUND", resourceNotFound);
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, action: operation.action, reason: decision.reason };
  }
  const decision = await operation.authorize(input, { ...context, resource });
  if (decision.allowed && resourceNotFound) throw new AppError("NOT_FOUND", resourceNotFound);
  return decision;
}

type ActionOfKind<Kind extends CompiledAppAction["kind"]> = Extract<
  CompiledAppAction,
  { kind: Kind }
>;

/**
 * A `connection` action. The caller needs the right on the Connection beside the one on the
 * App, by the Connection operation's own rule.
 */
function connectionBinding(action: ActionOfKind<"connection">): AppActionBinding {
  return {
    operation: connectionOperationName(action.connection, action.operation),
    target: { connection: action.connection, operation: action.operation },
    assetKind: CONNECTION_ASSET_KIND,
    admit(operation) {
      if (!operation) return { refusal: connectionCallError("operation_unknown") };
      // The build cannot know the Connection: an action that calls itself reading and stands
      // for an operation that changes would run a change without an `Idempotency-Key` and
      // outside the safe mode of a draft. It is refused before the operation is reached.
      return operation.effect === "changing" && action.effect === "reading"
        ? {
            refusal: new AppError(
              "CONFLICT",
              `The action '${action.name}' is declared reading and the operation it calls changes something. Declare the action changing.`,
              { reason: "action_effect_too_weak" },
              { exposeMessage: true }
            )
          }
        : { operation };
    },
    // The viewer needs the right on the Connection as well as the one on the App.
    authorize: (operation, context, _host, resolveResource) =>
      authorizeCaller(operation, context, resolveResource),
    inputOf: (parameters) => applyAppActionMapping(action.input.mapping, parameters),
    inputRefusal: () => connectionCallError("input_invalid"),
    describe: (appTitle) => `The action '${action.name}' of the App '${appTitle}'.`
  };
}

/**
 * An `sql` action on a Data Store. A reading one stands for the store's query, which runs its
 * statement read-only with the values bound. A changing one stands for the store's insert,
 * which adds its one row under the store's size limit. Both run as the store's app role.
 *
 * The right to the store is checked on the App and not of each person
 * (data-stores-and-knowledge-bases.md, Scope). The publisher of a revision was asked for it
 * at the publish (`requireDataStores`), so a person who may use the published App needs
 * nothing on the store. A draft was never published: who writes it reaches the store with
 * the right of their own, as they would by the store's operation itself. The manifest bounds
 * what the App reaches: the one store it lists, in the App's workspace or on the instance,
 * which is asked again at every call.
 */
function dataStoreBinding(action: ActionOfKind<"sql">): AppActionBinding {
  const unavailable = () => dataStoreRefusalError("data_store_unavailable", action.dataStore);
  const names = action.parameters.map(({ name }) => name);
  const takes =
    names.length > 0
      ? `It takes ${names.join(", ")}; a parameter that is not required may be left out.`
      : "It takes no parameter.";
  return {
    operation: dataStoreOperationName(
      action.dataStore,
      action.effect === "reading" ? "query" : "insert"
    ),
    target: { dataStore: action.dataStore },
    assetKind: DATA_STORE_ASSET_KIND,
    module: "dataStores",
    admit(operation, host) {
      const unlisted = unlistedDataStore(host.dataStores, action);
      if (unlisted) return { refusal: unlisted };
      // A Page is no App, and only the manifest of an App binds a store.
      if (!host.resource) {
        return { refusal: dataStoreRefusalError("data_store_needs_app", action.dataStore) };
      }
      if (!operation) return { refusal: unavailable() };
      // A store of another workspace is answered as one that does not exist.
      const owner = operation.resource(undefined)?.workspaceId;
      return owner === undefined || owner === host.resource.workspaceId
        ? { operation }
        : { refusal: unavailable() };
    },
    authorize: (operation, context, host, resolveResource) =>
      host.published ? { allowed: true } : authorizeCaller(operation, context, resolveResource),
    inputOf: (parameters) =>
      action.effect === "reading"
        ? {
            sql: action.statement,
            parameters: bindSqlActionParameters(action.parameters, parameters)
          }
        : {
            table: action.insert.table,
            // A parameter that was left out leaves its column empty.
            rows: [
              Object.fromEntries(
                action.insert.columns.map(({ column, parameter }) => [
                  column,
                  (Object.hasOwn(parameters, parameter) ? parameters[parameter] : undefined) ?? null
                ])
              )
            ],
            onConflict: action.insert.onConflict
          },
    inputRefusal: () =>
      new AppError("INTERNAL", "The compiled statement of an action does not fit its Data Store"),
    describe: (appTitle) =>
      action.effect === "reading"
        ? `Reads rows of the Data Store '${action.dataStore}' with the statement the App '${appTitle}' keeps as its action '${action.name}'. Use it for what that App shows; it changes nothing. ${takes} A parameter that is left out does not narrow the result. The answer holds "columns", "rows" and "truncated". A result is cut at the store's caps for rows and bytes, and "truncated" says when it was: page or narrow the call with its parameters.`
        : `Adds one row to the table '${action.insert.table}' of the Data Store '${action.dataStore}', as the action '${action.name}' of the App '${appTitle}' does. Use it to record what that App records; it changes and removes no row. ${takes} The answer says whether the row was added${action.insert.onConflict === "skip" ? ' or, where one with its key exists, left out ("skipped")' : ""}.`
  };
}

/**
 * A `workflow` action starts a run of the published revision of its Workflow, as the viewer:
 * the viewer needs `workflow.use` on the Workflow beside the right on the App, by the rule of
 * `workflows.start` itself, in a draft as in the published App. The run acts as the
 * Workflow's own principal, never with the rights of the person who started it. The answer is
 * the run as `workflows.start` answers it; its state is read later with
 * `apps.sessions.get_workflow_run`.
 */
function workflowBinding(action: ActionOfKind<"workflow">): AppActionBinding {
  const startOf = (parameters: JsonObject) => ({
    workflow: action.workflow,
    input: applyAppActionMapping(action.input.mapping, parameters)
  });
  return {
    operation: "workflows.start",
    target: { workflow: action.workflow },
    assetKind: WORKFLOW_ASSET_KIND,
    module: "workflows",
    admit: (operation) =>
      operation
        ? { operation }
        : { refusal: new AppError("NOT_FOUND", "This instance has no Workflows") },
    authorize: (operation, context, _host, resolveResource) =>
      authorizeCaller(operation, context, resolveResource, { workflow: action.workflow }),
    inputOf: startOf,
    inputRefusal: () =>
      new AppError(
        "INTERNAL",
        "The compiled mapping of an action does not fit the start of a Workflow"
      ),
    describe: (appTitle) =>
      `Starts a run of the Workflow '${action.workflow}', as the action '${action.name}' of the App '${appTitle}' does. The answer is the run with its id and status; the run goes on after the answer.`,
    dryRun(parameters) {
      const start = startOf(parameters);
      return {
        wouldHave: `Would have started the Workflow '${action.workflow}' with ${JSON.stringify(start.input)}.`,
        input: start
      };
    }
  };
}

/** What a compiled action stands for, by its kind. */
export function appActionBinding(action: CompiledAppAction): AppActionBinding {
  switch (action.kind) {
    case "connection":
      return connectionBinding(action);
    case "sql":
      return dataStoreBinding(action);
    case "workflow":
      return workflowBinding(action);
  }
}
