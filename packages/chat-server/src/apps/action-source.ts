import { APP_ASSET_KIND, type AppActionPermission } from "@vivd-catalyst/api-contract";
import {
  appActionInputAsZod,
  applyAppActionMapping,
  compiledActionsOf,
  type CompiledAppAction
} from "@vivd-catalyst/app-build";
import {
  APP_ACTION_OPERATION_PREFIX,
  AppError,
  CONNECTION_ASSET_KIND,
  POLICY_VALUES,
  appActionOperationName,
  asCollaborationWorkspaceId,
  connectionCallError,
  connectionOperationName,
  liveRevisionId,
  parseAppActionOperationName,
  resolvePolicy,
  type CentralPolicySetting,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
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
} from "@vivd-catalyst/core";
import { z } from "zod";
import { decide } from "../asset-access";
import { APP_ACTIONS } from "./app-kind";

// A named action of an App as an operation of the platform. The action stands for one
// operation of one Connection. Its definition wraps that operation's own definition, as the
// Connections' source built it: the caller's right on the Connection, the exposure to the
// caller's surface, the egress check, the credential and the connector are that definition's
// and are reached through it, never around it. What the action adds is the right on the App,
// the check of its parameters, the mapping of them into the operation's input, and a policy
// that is never looser than the operation's.

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
  /** Resolves the Connection operation an action stands for. */
  registry: Pick<OperationRegistry, "resolve" | "resolveMany">;
  policy: {
    instanceDefaults: PolicyDefaults;
    centralSettings(): readonly CentralPolicySetting[] | Promise<readonly CentralPolicySetting[]>;
  };
}

/** The Page or the revision of an App an action belongs to. */
export interface AppActionHost {
  /**
   * The operation one action runs as: `app.<id>.<action>` for an App, and
   * `page_action.<page id>.<action>` for a Page of a conversation, which is no App whatever
   * id its manifest names.
   */
  operationName(action: string): string;
  /** What the run names as touched. A Page is no asset and names none. */
  resource: OperationResource | undefined;
  /** Whether the caller may use this Page or this revision of the App. Asked first. */
  authorize(
    context: OperationAuthorizeContext
  ): OperationAuthorization | Promise<OperationAuthorization>;
}

export interface AppActionDefinition {
  definition: OperationDefinition;
  /**
   * The Connection operation the action stands for exists and is not stronger than the action
   * says. A call of an action that is not callable is recorded and refused with the reason.
   */
  callable: boolean;
}

function strictest(left: PolicyValue, right: PolicyValue | undefined): PolicyValue {
  return right !== undefined && POLICY_VALUES.indexOf(right) > POLICY_VALUES.indexOf(left)
    ? right
    : left;
}

/**
 * What the Connection operation's own policy asks, as a value: its declared default or the
 * instance default, and every central setting that names it. Read as its caller's own
 * confirmation would count, so the value is the one that was set and not what a surface
 * makes of it.
 */
async function targetPolicy(
  environment: AppActionEnvironment,
  target: OperationDefinition,
  workspaceId: string | undefined
): Promise<PolicyValue> {
  return resolvePolicy({
    definition: target,
    origin: { kind: "user" },
    instanceDefaults: environment.policy.instanceDefaults,
    centralSettings: await environment.policy.centralSettings(),
    targets: [{ workspaceId, assetKind: CONNECTION_ASSET_KIND }],
    callerCanConfirm: true,
    canPause: true
  }).value;
}

/** The caller's right on the Connection operation, by that operation's own rule. */
function authorizeTarget(
  target: OperationDefinition,
  context: OperationAuthorizeContext
): OperationAuthorization | Promise<OperationAuthorization> {
  const resource = target.resource(undefined);
  if (target.action !== null) {
    const decision = context.access.authorize(target.action, resource);
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, action: target.action, reason: decision.reason };
  }
  return target.authorize(undefined, { ...context, resource });
}

/**
 * The operation `app.<id>.<action>`. Its call is one Operation Run. The run names the action
 * and, in its origin, the Connection and the operation by name. Nothing of the input and
 * nothing of the result is written anywhere but where the call path keeps the answer of a
 * changing call for its `Idempotency-Key`.
 */
export async function appActionDefinition(
  environment: AppActionEnvironment,
  host: AppActionHost,
  action: CompiledAppAction
): Promise<AppActionDefinition> {
  const target = await environment.registry.resolve(
    connectionOperationName(action.connection, action.operation)
  );
  // The build cannot know the Connection: an action that calls itself reading and stands for
  // an operation that changes would run a change without an `Idempotency-Key` and outside the
  // safe mode of a draft. It is refused before the operation is reached.
  const weaker = target?.effect === "changing" && action.effect === "reading";
  const floor = target
    ? strictest(await targetPolicy(environment, target, host.resource?.workspaceId), action.policy)
    : action.policy;
  const parameters = appActionInputAsZod(action.input.schema);
  const definition: OperationDefinition = {
    name: host.operationName(action.name),
    effect: action.effect,
    // A read of a customer's system is recorded, every time.
    ...(action.effect === "reading" ? { recordsEveryCall: true as const } : {}),
    ...(floor === undefined || floor === "allow" ? {} : { policyFloor: floor }),
    action: null,
    async authorize(_input, context) {
      const own = await host.authorize(context);
      if (!own.allowed || !target) return own;
      return authorizeTarget(target, context);
    },
    scope: null,
    auth: "user",
    inputSchema: parameters,
    // The result is checked inside the Connection's call, where a failure has its reason.
    outputSchema: z.unknown(),
    resource: () => host.resource,
    module: APPS_MODULE,
    timeoutMs: target?.timeoutMs ?? APP_ACTION_DEFAULT_TIMEOUT_MS,
    async execute(input, context) {
      if (!target) {
        throw connectionCallError("operation_unknown");
      }
      if (weaker) {
        throw new AppError(
          "CONFLICT",
          `The action '${action.name}' is declared reading and the operation it calls changes something. Declare the action changing.`,
          { reason: "action_effect_too_weak" },
          { exposeMessage: true }
        );
      }
      const mapped = target.inputSchema.safeParse(
        applyAppActionMapping(action.input.mapping, parameters.parse(input))
      );
      if (!mapped.success) {
        throw connectionCallError("input_invalid");
      }
      return target.execute(mapped.data, context);
    }
  };
  return { definition, callable: target !== undefined && !weaker };
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
 * `can` map of a frame. It reads each Connection the actions name once, whatever the number
 * of actions and of operations they stand for, and the central settings once. Each Connection
 * is two point reads, so a manifest whose actions name `c` Connections costs `2c` reads and
 * one of the settings. An operation that was not read here does not exist to it.
 */
export async function preloadedEnvironment(
  environment: AppActionEnvironment,
  actions: readonly Pick<CompiledAppAction, "connection" | "operation">[]
): Promise<AppActionEnvironment> {
  const targets = await environment.registry.resolveMany(
    actions.map((action) => connectionOperationName(action.connection, action.operation))
  );
  let settings: Promise<readonly CentralPolicySetting[]> | undefined;
  return {
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
    policy: {
      instanceDefaults: environment.policy.instanceDefaults,
      centralSettings: () => (settings ??= Promise.resolve(environment.policy.centralSettings()))
    }
  };
}

export interface AppActionSourceDeps extends AppActionEnvironment {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets">;
  modules: Pick<ModuleSnapshot, "isEnabled">;
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
}): OperationResource {
  return {
    kind: APP_ASSET_KIND,
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
  if (context.access.authorize(APP_ACTIONS.write, resource).allowed) {
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
  view: "published" | "draft"
): AppActionHost {
  return {
    operationName: (action) => appActionOperationName(appName, action),
    resource,
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
    id: asset.id,
    name: asset.name,
    workspaceId: asset.scope.workspaceId
  });
  return {
    host: {
      ...appRevisionHost(asset.name, resource, "published"),
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
    async resolve(name) {
      const parsed = parseAppActionOperationName(name);
      if (!parsed || !deps.modules.isEnabled(APPS_MODULE)) return undefined;
      const app = publishedApp(
        await store.getConfigAsset({ clientInstanceId, kind: APP_ASSET_KIND, name: parsed.app })
      );
      const action = app?.actions.find((candidate) => candidate.name === parsed.action);
      if (!app || !action) return undefined;
      return (await appActionDefinition(deps, app.host, action)).definition;
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
  /** The Connections' own tool source: it says which operations an agent may carry now. */
  connectionTools: DataToolSource;
}

/**
 * The named actions an agent lists, as tools. An action is described where its App is
 * published and the Connection operation it stands for is callable now and exposed to
 * agents, which the Connections' own tool source says. One query for the Apps the list
 * names, at most `APP_ACTION_TOOL_MAX_APPS` of them, and one read of the Connections.
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
      const carried = new Map(
        (
          await deps.connectionTools.describe(
            [
              ...new Set(
                found.map(({ action }) =>
                  connectionOperationName(action.connection, action.operation)
                )
              )
            ],
            scope
          )
        ).map((tool) => [tool.name, tool])
      );
      const tools: DataToolDescriptor[] = [];
      for (const { name, app, action } of found) {
        const target = carried.get(connectionOperationName(action.connection, action.operation));
        // An action that says it reads and stands for a changing operation is no tool.
        if (!target || (target.effect === "changing" && action.effect === "reading")) continue;
        tools.push({
          name,
          description: (
            action.description ?? `The action '${action.name}' of the App '${app.title}'.`
          ).slice(0, APP_ACTION_TOOL_DESCRIPTION_MAX_CHARS),
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

/** Two tool sources as one. Each is asked for the names it knows. */
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
