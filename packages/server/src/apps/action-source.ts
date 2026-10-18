import { APP_ASSET_KIND, type AppActionPermission } from "@work-shape/catalyst-api-contract";
import {
  appActionInputAsZod,
  compiledActionsOf,
  declaredDataStoresOf,
  type CompiledAppAction
} from "@work-shape/catalyst-app-build";
import {
  APP_ACTION_OPERATION_PREFIX,
  APP_MODES,
  AppError,
  POLICY_VALUES,
  appActionOperationName,
  asCollaborationWorkspaceId,
  liveRevisionId,
  moduleOffError,
  parseAppActionOperationName,
  resolvePolicy,
  type CentralPolicySetting,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type DataStoreReference,
  type DataToolDescriptor,
  type DataToolSource,
  type Logger,
  type ModuleSnapshot,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationDefinition,
  type OperationOrigin,
  type OperationRegistry,
  type OperationResource,
  type OperationSource,
  type PolicyDefaults,
  type PolicyValue
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { RunOperationDeps } from "@work-shape/catalyst-tool-execution";
import { decide } from "../assets/asset-access";
import { appActionBinding, type AppActionOwner } from "./action-kinds";
import { APP_ACTIONS } from "./app-kind";

// A named action of an App as an operation of the platform. The action stands for one
// operation of the registry, which its kind names (`action-kinds.ts`): an operation of a
// Connection, or the query of a Data Store. Its definition wraps that operation's own
// definition: what guards the operation, such as a Connection's exposure, egress check and
// credential or a store's read-only transaction and app role, is that definition's and is
// reached through it, never around it. Whose right on it is asked is the kind's to say. What
// the action adds is the right on the App, the
// check of its parameters, the making of the operation's input from them, and a policy that
// is never looser than the operation's.

/** The module that brings Apps and their actions. */
const APPS_MODULE = "apps";

/**
 * How long a call of an action may run where the operation it stands for is gone and names no
 * time of its own. Such a call ends at once with the reason.
 */
const APP_ACTION_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * How many published Apps one listing of the source reads, in one query. Where more are
 * published, the listing holds the actions of the first so many by name and says in
 * `truncated` that it left some out.
 */
export const APP_ACTION_LIST_MAX_APPS = 2000;

/**
 * How many Apps the tool list of one agent is read from, in one query. An agent whose list
 * names actions of more Apps runs without the actions of the Apps after the first so many by
 * name: the run lists them as missing, and a warning says how many Apps were left out.
 */
export const APP_ACTION_TOOL_MAX_APPS = 50;

/** How long the description of an action is at most as a model is sent it. */
export const APP_ACTION_TOOL_DESCRIPTION_MAX_CHARS = 2000;

/** What a definition of an action is built with: where its operation and the policy are read. */
export interface AppActionEnvironment {
  resolveResource: RunOperationDeps["resolveResource"];
  /** Resolves the operation an action stands for. */
  registry: Pick<OperationRegistry, "resolve" | "resolveMany">;
  /** Says whether the module that brings an action's operation is on. */
  modules: Pick<ModuleSnapshot, "isEnabled">;
  policy: {
    instanceDefaults: PolicyDefaults;
    centralSettings(): readonly CentralPolicySetting[] | Promise<readonly CentralPolicySetting[]>;
  };
}

/** The Page or the revision of an App an action belongs to. */
export interface AppActionHost extends AppActionOwner {
  /**
   * The operation one action runs as: `app.<id>.<action>` for an App, and
   * `page_action.<page id>.<action>` for a Page of a conversation, which is no App whatever
   * id its manifest names.
   */
  operationName(action: string): string;
  /**
   * The revision is the published one of its App: what its publisher answered for at the
   * publish holds for everybody who may use it. A draft and a Page were never published.
   */
  published: boolean;
  /** Whether the caller may use this Page or this revision of the App. Asked first. */
  authorize(
    context: OperationAuthorizeContext
  ): OperationAuthorization | Promise<OperationAuthorization>;
}

export interface AppActionDefinition {
  definition: OperationDefinition;
  /**
   * The operation the action stands for is there for it: its module is on, and its kind
   * admits it. A call of an action that is not callable is recorded and refused with the reason.
   */
  callable: boolean;
}

function strictest(left: PolicyValue, right: PolicyValue | undefined): PolicyValue {
  return right !== undefined && POLICY_VALUES.indexOf(right) > POLICY_VALUES.indexOf(left)
    ? right
    : left;
}

/**
 * What the policy of the operation an action stands for asks, as a value: its declared
 * default or the instance default, and every central setting that names it. Read as its
 * caller's own confirmation would count, so the value is the one that was set and not what a
 * surface makes of it.
 */
async function targetPolicy(
  environment: AppActionEnvironment,
  target: OperationDefinition,
  scope: { workspaceId: string | undefined; assetKind: string }
): Promise<PolicyValue> {
  return resolvePolicy({
    definition: target,
    origin: { kind: "user" },
    instanceDefaults: environment.policy.instanceDefaults,
    centralSettings: await environment.policy.centralSettings(),
    targets: [scope],
    callerCanConfirm: true,
    canPause: true
  }).value;
}

/**
 * The operation `app.<id>.<action>`. Its call is one Operation Run. The run names the action
 * and, in its origin, what the action reached by name. Nothing of the input and nothing of
 * the result is written anywhere but where the call path keeps the answer of a changing call
 * for its `Idempotency-Key`.
 */
export async function appActionDefinition(
  environment: AppActionEnvironment,
  host: AppActionHost,
  action: CompiledAppAction
): Promise<AppActionDefinition> {
  const binding = appActionBinding(action);
  const offModule =
    binding.module !== undefined && !environment.modules.isEnabled(binding.module)
      ? binding.module
      : undefined;
  const target =
    offModule === undefined ? await environment.registry.resolve(binding.operation) : undefined;
  const admitted =
    offModule === undefined ? binding.admit(target, host) : { refusal: moduleOffError(offModule) };
  const floor = target
    ? strictest(
        await targetPolicy(environment, target, {
          workspaceId: host.resource?.workspaceId,
          assetKind: binding.assetKind
        }),
        action.policy
      )
    : action.policy;
  const parameters = appActionInputAsZod(action.input.schema);
  const definition: OperationDefinition = {
    name: host.operationName(action.name),
    effect: action.effect,
    // A read of a customer's system or of a customer's rows is recorded, every time.
    ...(action.effect === "reading" ? { recordsEveryCall: true as const } : {}),
    ...(floor === undefined || floor === "allow" ? {} : { policyFloor: floor }),
    action: null,
    async authorize(_input, context) {
      // A module that is off refuses its operations before the caller's rights are known.
      if (offModule !== undefined) throw moduleOffError(offModule);
      const own = await host.authorize(context);
      if (!own.allowed || !target) return own;
      return binding.authorize(target, context, host, environment.resolveResource);
    },
    scope: null,
    auth: "user",
    inputSchema: parameters,
    // The result is checked inside the operation's own call, where a failure has its reason.
    outputSchema: z.unknown(),
    resource: () => host.resource,
    module: APPS_MODULE,
    timeoutMs: target?.timeoutMs ?? APP_ACTION_DEFAULT_TIMEOUT_MS,
    // The guardrails of the operation the action calls answer as they would its own call, as
    // the policy of that operation is the action's floor: a guardrail on a Data Store's insert
    // holds an App's insert too.
    async beforeEvents(input, origin) {
      if ("refusal" in admitted) return [];
      const { operation } = admitted;
      const mapped = await operation.inputSchema.safeParseAsync(
        binding.inputOf(parameters.parse(input))
      );
      // The call refuses an input that does not fit; there is nothing to check.
      if (!mapped.success) return [];
      return [
        {
          name: "operation.before_call",
          subject: { kind: "operation", name: operation.name },
          checkable: () => ({
            input: JSON.stringify(operation.inputWithoutSecrets?.(mapped.data) ?? mapped.data) ?? ""
          })
        },
        ...((await operation.beforeEvents?.(mapped.data, origin)) ?? [])
      ];
    },
    async execute(input, context) {
      if ("refusal" in admitted) {
        throw admitted.refusal;
      }
      // The schema of an operation an outside system described is checked in a worker thread.
      const mapped = await admitted.operation.inputSchema.safeParseAsync(
        binding.inputOf(parameters.parse(input))
      );
      if (!mapped.success) {
        throw binding.inputRefusal();
      }
      // The operation learns the call is the App's, whatever origin called the action.
      return admitted.operation.execute(mapped.data, { ...context, byAppAction: true });
    }
  };
  return { definition, callable: !("refusal" in admitted) };
}

/**
 * What a call of the action would come to for one caller now: refused, run, run as the
 * caller's own confirmation, or held for another person. The guardrails are not asked, so a
 * call can still be refused where this says it runs.
 */
export async function appActionPermission(
  environment: AppActionEnvironment,
  built: AppActionDefinition,
  context: OperationAuthorizeContext
): Promise<AppActionPermission> {
  const { definition } = built;
  if (!built.callable || definition.action !== null) return "deny";
  const right = await definition.authorize(undefined, context);
  if (!right.allowed) return "deny";
  return resolvePolicy({
    definition,
    origin: context.origin,
    instanceDefaults: environment.policy.instanceDefaults,
    centralSettings: await environment.policy.centralSettings(),
    targets: [{ workspaceId: context.workspaceId, assetKind: context.resource?.kind }],
    callerCanConfirm: true,
    canPause: false
  }).value;
}

/**
 * An environment for one request that builds the definitions of several actions, such as the
 * `can` map of a frame. It reads each Connection and each Data Store the actions name once,
 * whatever the number of actions and of operations they stand for, and the central settings
 * once. Each of them is two point reads, so a manifest whose actions name `c` Connections and
 * stores costs `2c` reads and one of the settings. An operation that was not read here does
 * not exist to it.
 */
export async function preloadedEnvironment(
  environment: AppActionEnvironment,
  actions: readonly CompiledAppAction[]
): Promise<AppActionEnvironment> {
  const targets = await environment.registry.resolveMany(
    actions.map((action) => appActionBinding(action).operation)
  );
  let settings: Promise<readonly CentralPolicySetting[]> | undefined;
  return {
    resolveResource: environment.resolveResource,
    registry: {
      resolve: (name) => Promise.resolve(targets.get(name)),
      resolveMany: (names) =>
        Promise.resolve(
          new Map(
            names.flatMap((name) => {
              const target = targets.get(name);
              return target ? [[name, target] as const] : [];
            })
          )
        )
    },
    modules: environment.modules,
    policy: {
      instanceDefaults: environment.policy.instanceDefaults,
      centralSettings: () => (settings ??= Promise.resolve(environment.policy.centralSettings()))
    }
  };
}

export interface AppActionSourceDeps extends AppActionEnvironment {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets">;
  /** `APP_ACTION_LIST_MAX_APPS` unless a test of the limit sets a smaller one. */
  listMaxApps?: number;
}

/** The App a published revision of which people are served, with what its actions need. */
interface PublishedApp {
  host: AppActionHost;
  /** The revision people are served: what a held call of an action is pinned to. */
  revisionId: string;
  title: string;
  actions: CompiledAppAction[];
}

/**
 * A call that waited for an approval was made in a frame of one revision, or by an agent
 * whose tool was read from one, and the approver read what that revision's action does. It
 * is executed only while that revision is still the published one. The compiled mapping is not kept with the call, since a revision that
 * was replaced is no longer served to anybody and nothing of it should still run. So a call
 * whose revision was replaced ends with this sentence, and nothing is carried out.
 */
export function requirePublishedRevision(
  origin: OperationOrigin,
  publishedRevisionId: string | undefined
): void {
  const madeIn =
    origin.kind === "app"
      ? origin.appRevisionId
      : origin.kind === "agent"
        ? origin.toolRevisionId
        : undefined;
  // A call that names no revision, such as a person's own from the API, is not pinned.
  if (madeIn !== undefined && madeIn !== publishedRevisionId) {
    throw new AppError(
      "CONFLICT",
      "The App was published again after this call was made, so the call was not carried out and nothing was changed. Make the call again in the App.",
      { reason: "app_revision_changed" },
      { exposeMessage: true }
    );
  }
}

const titleSchema = z.object({ title: z.string() });

/** What people read as the name of an App, from the config of one of its revisions. */
export function appTitleOf(config: unknown, appName: string): string {
  const title = titleSchema.safeParse(config);
  return title.success ? title.data.title : appName;
}

/** The resource a right on an App is decided on. */
export function appResourceOf(asset: {
  id: string;
  name: string;
  workspaceId?: string;
  appAvailability?: ConfigAssetRecord["appAvailability"];
}): OperationResource {
  return {
    kind: APP_ASSET_KIND,
    ...(asset.appAvailability ? { appAvailability: asset.appAvailability } : {}),
    id: asset.id,
    assetId: asset.id,
    name: asset.name,
    ...(asset.workspaceId === undefined
      ? {}
      : { workspaceId: asCollaborationWorkspaceId(asset.workspaceId) })
  };
}

/**
 * Who is served the published revision of an App: whoever writes it, and whoever holds the
 * use right on it. The rule of `apps.preview`.
 */
export function authorizePublishedApp(
  context: Pick<OperationAuthorizeContext, "access">,
  resource: OperationResource
): OperationAuthorization {
  if (
    resource.appAvailability?.audience !== "self" &&
    context.access.authorize(APP_ACTIONS.write, resource).allowed
  ) {
    return { allowed: true };
  }
  return decide(context.access, APP_ACTIONS.use, resource);
}

/**
 * The host of the actions of one revision of an App. The published revision is for whoever is
 * served it, the draft for whoever writes the App.
 */
export function appRevisionHost(
  appName: string,
  resource: OperationResource,
  view: (typeof APP_MODES)[number],
  /** The Data Stores the manifest of the revision lists (`declaredDataStoresOf`). */
  dataStores: readonly DataStoreReference[]
): AppActionHost {
  return {
    operationName: (action) => appActionOperationName(appName, action),
    resource,
    dataStores,
    published: view === "published",
    authorize: (context) =>
      view === "published"
        ? authorizePublishedApp(context, resource)
        : decide(context.access, APP_ACTIONS.write, resource)
  };
}

function publishedApp(asset: ConfigAssetRecord | undefined): PublishedApp | undefined {
  const revisionId = asset && liveRevisionId(asset, { lifecycle: "draft_published" });
  if (
    !asset ||
    asset.status !== "active" ||
    asset.scope.kind !== "workspace" ||
    revisionId === undefined ||
    !asset.publishedConfig
  ) {
    return undefined;
  }
  const resource = appResourceOf({
    appAvailability: asset.appAvailability,
    id: asset.id,
    name: asset.name,
    workspaceId: asset.scope.workspaceId
  });
  return {
    host: {
      ...appRevisionHost(
        asset.name,
        resource,
        "published",
        declaredDataStoresOf(asset.publishedConfig.manifest)
      ),
      authorize(context) {
        requirePublishedRevision(context.origin, revisionId);
        return authorizePublishedApp(context, resource);
      }
    },
    revisionId,
    title: appTitleOf(asset.publishedConfig, asset.name),
    actions: compiledActionsOf(asset.publishedConfig.manifest)
  };
}

/**
 * The source of the named actions of every published App. `resolve` reads the one App a name
 * stands for and the one Connection its action names. A draft is never read here: only what
 * an App's users are served has operations of this source. A call from a frame that is
 * resolved here is one that waited: it runs only where its revision is still the published
 * one (`requirePublishedRevision`). `list` reads at most `APP_ACTION_LIST_MAX_APPS` published
 * Apps in one query and each Connection they name once.
 */
export function createAppActionOperationSource(deps: AppActionSourceDeps): OperationSource {
  const { clientInstanceId, store } = deps;
  return {
    async resolve(name, stores) {
      const parsed = parseAppActionOperationName(name);
      if (!parsed || !deps.modules.isEnabled(APPS_MODULE)) return undefined;
      const app = publishedApp(
        await (stores?.configAssets ?? store).getConfigAsset({
          clientInstanceId,
          kind: APP_ASSET_KIND,
          name: parsed.app
        })
      );
      const action = app?.actions.find((candidate) => candidate.name === parsed.action);
      if (!app || !action) return undefined;
      const environment = stores
        ? {
            ...deps,
            registry: {
              resolve: (name: string) => deps.registry.resolve(name, stores),
              resolveMany: (names: readonly string[]) => deps.registry.resolveMany(names, stores)
            }
          }
        : deps;
      return (await appActionDefinition(environment, app.host, action)).definition;
    },
    async list() {
      if (!deps.modules.isEnabled(APPS_MODULE)) return { operations: [], truncated: [] };
      const maxApps = deps.listMaxApps ?? APP_ACTION_LIST_MAX_APPS;
      // One more than is listed, so that a listing that leaves Apps out knows it.
      const assets = await store.listPublishedConfigAssets({
        clientInstanceId,
        kind: APP_ASSET_KIND,
        limit: maxApps + 1
      });
      const apps = assets.slice(0, maxApps).flatMap((asset) => publishedApp(asset) ?? []);
      const environment = await preloadedEnvironment(
        deps,
        apps.flatMap((app) => app.actions)
      );
      const operations: OperationDefinition[] = [];
      for (const app of apps) {
        for (const action of app.actions) {
          const built = await appActionDefinition(environment, app.host, action);
          if (built.callable) operations.push(built.definition);
        }
      }
      return {
        operations,
        truncated:
          assets.length > maxApps
            ? [
                {
                  prefix: APP_ACTION_OPERATION_PREFIX,
                  limit: maxApps,
                  limitName: "APP_ACTION_LIST_MAX_APPS"
                }
              ]
            : []
      };
    }
  };
}

export interface AppActionToolSourceDeps {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "listPublishedConfigAssets">;
  modules: Pick<ModuleSnapshot, "isEnabled">;
  /** Told when a tool list names more Apps than one read takes. */
  logger?: Pick<Logger, "warn">;
  /** `APP_ACTION_TOOL_MAX_APPS` unless a test of the limit sets a smaller one. */
  maxApps?: number;
  /**
   * The tool sources of what actions stand for, the Connections' and the Data Stores': they
   * say which operations are callable now, and for a Connection's whether agents reach them.
   */
  targetTools: DataToolSource;
}

/**
 * The named actions an agent lists, as tools. An action is described where its App is
 * published and the operation it stands for is callable now, which that operation's own tool
 * source says: for a Connection's, that agents are exposed to it too. One query for the Apps
 * the list names, at most `APP_ACTION_TOOL_MAX_APPS` of them, and one read of their targets.
 */
export function createAppActionToolSource(deps: AppActionToolSourceDeps): DataToolSource {
  const { clientInstanceId, store } = deps;
  return {
    async describe(toolNames, scope) {
      const wanted = toolNames.flatMap((name) => {
        const parsed = parseAppActionOperationName(name);
        return parsed ? [{ name, ...parsed }] : [];
      });
      if (wanted.length === 0 || !deps.modules.isEnabled(APPS_MODULE)) return [];
      // By name, so that which Apps are left out does not change from one run to the next.
      const named = [...new Set(wanted.map((entry) => entry.app))].sort();
      const maxApps = deps.maxApps ?? APP_ACTION_TOOL_MAX_APPS;
      const appNames = named.slice(0, maxApps);
      if (named.length > appNames.length) {
        deps.logger?.warn(
          {
            type: "app_action.tools_left_out",
            namedApps: named.length,
            leftOutApps: named.length - appNames.length,
            limit: maxApps,
            limitName: "APP_ACTION_TOOL_MAX_APPS"
          },
          "A tool list names actions of more Apps than one read takes; the actions of the Apps after the limit are left out"
        );
      }
      const apps = new Map(
        (
          await store.listPublishedConfigAssets({
            clientInstanceId,
            kind: APP_ASSET_KIND,
            names: appNames,
            limit: appNames.length
          })
        ).flatMap((asset) => {
          const app = publishedApp(asset);
          return app ? [[asset.name, app] as const] : [];
        })
      );
      const found = wanted.flatMap((entry) => {
        const app = apps.get(entry.app);
        const action = app?.actions.find((candidate) => candidate.name === entry.action);
        return app && action ? [{ name: entry.name, app, action }] : [];
      });
      if (found.length === 0) return [];
      const bound = found.map((entry) => ({ ...entry, binding: appActionBinding(entry.action) }));
      const carried = new Map(
        (
          await deps.targetTools.describe(
            [...new Set(bound.map(({ binding }) => binding.operation))],
            scope
          )
        ).map((tool) => [tool.name, tool])
      );
      const tools: DataToolDescriptor[] = [];
      for (const { name, app, action, binding } of bound) {
        const target = carried.get(binding.operation);
        // An action that says it reads and stands for a changing operation is no tool.
        if (!target || (target.effect === "changing" && action.effect === "reading")) continue;
        tools.push({
          name,
          description: (action.description ?? binding.describe(app.title)).slice(
            0,
            APP_ACTION_TOOL_DESCRIPTION_MAX_CHARS
          ),
          inputJsonSchema: action.input.schema,
          effect: action.effect,
          // What a call of the tool is pinned to while it waits for an approval.
          revisionId: app.revisionId
        });
      }
      return tools;
    }
  };
}

/** Several tool sources as one. Each is asked for the names it knows. */
export function combineDataToolSources(...sources: readonly DataToolSource[]): DataToolSource {
  return {
    async describe(toolNames, scope) {
      const described = await Promise.all(
        sources.map((source) => source.describe(toolNames, scope))
      );
      return described.flat();
    }
  };
}
