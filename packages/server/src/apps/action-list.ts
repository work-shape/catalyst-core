import {
  APP_ASSET_KIND,
  type AppAction,
  type AppActionUnavailable,
  type AppActions,
  type AppMode
} from "@work-shape/catalyst-api-contract";
import {
  compiledActionsOf,
  declaredDataStoresOf,
  type CompiledAppAction
} from "@work-shape/catalyst-app-build";
import {
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  OPERATION_EFFECTS,
  appActionOperationName,
  connectionOperationName,
  draftCallTarget,
  liveRevisionId,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type ConnectionExposure,
  type DataStoreReference,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { decide } from "../assets/asset-access";
import type { ResolvedChatServerOptions } from "../types";
import { appActionPermissions } from "./action-call";
import {
  appActionDefinition,
  appResourceOf,
  appRevisionHost,
  appTitleOf,
  preloadedEnvironment,
  type AppActionEnvironment
} from "./action-source";
import { APP_ACTIONS } from "./app-kind";

type ConnectionAction = Extract<CompiledAppAction, { kind: "connection" }>;

// The named actions of an App as a person reads them: what each reaches, what a call of it
// would come to for the reader, and why a call cannot reach its operation where it cannot.
// Nothing is called here and no outside system is contacted. The policy is resolved by the
// rule a call from the revision's frame is decided by, so the list and the call agree.

/**
 * How many published Apps one answer without a named App lists, in one query. Where more are
 * published, the answer holds the first so many by name and says so in `truncated`.
 */
const APP_ACTIONS_LIST_MAX_APPS = 200;

/** The exposure a call from the frame of an App needs of a Connection's operation. */
const APP_EXPOSURE: ConnectionExposure = "bridge";

/** What the list reads of a Connection's config. A config of another shape counts as missing. */
const connectionFactsSchema = z.object({
  displayName: z.string(),
  enabled: z.boolean(),
  operations: z.array(
    z.object({ name: z.string(), enabled: z.boolean(), exposure: z.array(z.string()) })
  )
});

interface ConnectionFacts extends z.infer<typeof connectionFactsSchema> {
  /** The reader may read the Connection, so its label is told. */
  readable: boolean;
}

const manifestOfConfigSchema = z.object({ manifest: z.unknown() });
const storeTitleSchema = z.object({ title: z.string() });

/** One revision of an App, as the list reads it. */
interface ListedRevision {
  asset: ConfigAssetRecord;
  view: AppMode;
  revision: number;
  revisionId: string;
  title: string;
  actions: CompiledAppAction[];
  /** The Data Stores the manifest of the revision lists. */
  dataStores: DataStoreReference[];
}

function listedRevision(asset: ConfigAssetRecord, view: AppMode): ListedRevision | undefined {
  if (asset.status !== "active" || asset.scope.kind !== "workspace") return undefined;
  const live = liveRevisionId(asset, { lifecycle: "draft_published" });
  const shown =
    view === "draft"
      ? { config: asset.config, revision: asset.revision, revisionId: asset.activeRevisionId }
      : live !== undefined && live === asset.publishedRevisionId
        ? { config: asset.publishedConfig, revision: asset.publishedRevision, revisionId: live }
        : undefined;
  const config = manifestOfConfigSchema.safeParse(shown?.config);
  if (!shown || shown.revision === undefined || !config.success) return undefined;
  return {
    asset,
    view,
    revision: shown.revision,
    revisionId: shown.revisionId,
    title: appTitleOf(shown.config, asset.name),
    actions: compiledActionsOf(config.data.manifest),
    dataStores: declaredDataStoresOf(config.data.manifest)
  };
}

function unavailableOf(
  action: ConnectionAction,
  connection: ConnectionFacts | undefined
): AppActionUnavailable | undefined {
  if (!connection) return "connection_missing";
  if (!connection.enabled) return "connection_disabled";
  const operation = connection.operations.find((candidate) => candidate.name === action.operation);
  if (!operation) return "operation_missing";
  if (!operation.enabled) return "operation_disabled";
  return operation.exposure.includes(APP_EXPOSURE) ? undefined : "not_exposed";
}

export class AppActionList {
  private readonly options: ResolvedChatServerOptions;
  private readonly environment: AppActionEnvironment;

  constructor(options: ResolvedChatServerOptions) {
    this.options = options;
    this.environment = {
      registry: options.operationCalls.registry,
      modules: options.modules,
      policy: options.operationCalls.deps.policy
    };
  }

  /**
   * The right to read the App the call names, decided on the stored App or on the name alone
   * where none carries it. A call that names none is decided per App where the list is built.
   */
  async authorize(access: ActorAccess, input: { app?: string }): Promise<OperationAuthorization> {
    if (input.app === undefined) return { allowed: true };
    const asset = await this.app(input.app);
    return decide(
      access,
      APP_ACTIONS.read,
      asset ? appResourceOf(scoped(asset)) : { kind: APP_ASSET_KIND, name: input.app }
    );
  }

  /**
   * The actions of the App the call names: of its draft for whoever writes the App, of the
   * published revision for every other reader. Without a name, the actions of the published
   * revision of every App the caller reads, at most `APP_ACTIONS_LIST_MAX_APPS` Apps.
   */
  async list(
    caller: { actor: AuthenticatedIdentity; access: ActorAccess },
    input: { app?: string }
  ): Promise<AppActions> {
    const reads = (asset: ConfigAssetRecord, action: string) =>
      caller.access.authorize(action, appResourceOf(scoped(asset))).allowed;
    let revisions: ListedRevision[];
    let truncated = false;
    if (input.app !== undefined) {
      const asset = await this.app(input.app);
      const view = asset && reads(asset, APP_ACTIONS.write) ? "draft" : "published";
      const revision = asset && listedRevision(asset, view);
      if (!revision) {
        throw asset?.status === "active"
          ? new AppError("NOT_FOUND", "The App is not published", { reason: "not_published" })
          : new AppError("NOT_FOUND", "App is not available");
      }
      revisions = [revision];
    } else {
      // One more than is listed, so that an answer that leaves Apps out knows it.
      const assets = await this.options.stores.configAssets.listPublishedConfigAssets({
        clientInstanceId: this.options.clientInstanceId,
        kind: APP_ASSET_KIND,
        limit: APP_ACTIONS_LIST_MAX_APPS + 1
      });
      truncated = assets.length > APP_ACTIONS_LIST_MAX_APPS;
      revisions = assets
        .slice(0, APP_ACTIONS_LIST_MAX_APPS)
        .filter((asset) => reads(asset, APP_ACTIONS.read))
        .flatMap((asset) => listedRevision(asset, "published") ?? []);
    }
    const actions = revisions.flatMap((revision) => revision.actions);
    const [environment, connections, dataStores, agentTools] = await Promise.all([
      preloadedEnvironment(this.environment, actions),
      this.connections(caller.access, actions),
      this.dataStoreTitles(caller.access, actions),
      this.agentTools(revisions)
    ]);
    const apps: AppActions["apps"] = [];
    for (const revision of revisions) {
      const { asset } = revision;
      const resource = appResourceOf(scoped(asset));
      const host = appRevisionHost(asset.name, resource, revision.view, revision.dataStores);
      const targetOf = await this.draftTargets(caller.actor, revision);
      const can = await appActionPermissions(environment, {
        viewer: caller.actor,
        access: caller.access,
        // The reader has no frame open. Nothing of the decision reads the page session.
        pageSessionId: "",
        // The policy's word, for a changing action of a draft too: where a call of the draft
        // goes instead is its target, which the answer names beside it.
        mode: "published",
        host,
        revisionId: revision.revisionId,
        appName: asset.name,
        workspaceId: resource.workspaceId,
        actions: revision.actions
      });
      apps.push({
        name: asset.name,
        title: revision.title,
        view: revision.view,
        revision: revision.revision,
        actions: await Promise.all(
          revision.actions.map(async (action): Promise<AppAction> => {
            const listed = {
              name: action.name,
              effect: action.effect,
              ...(action.description === undefined ? {} : { description: action.description }),
              toolName: appActionOperationName(asset.name, action.name),
              inputSchema: action.input.schema,
              policy: can[action.name] ?? "deny",
              ...(targetOf ? { target: targetOf(action) } : {})
            };
            if (action.kind === "sql") {
              // The rule of a call: the store is listed, published, in the App's scope and
              // its module is on. The tool source describes the action by the same rule.
              const { callable } = await appActionDefinition(environment, host, action);
              const title = dataStores.get(action.dataStore);
              return {
                ...listed,
                kind: action.kind,
                dataStore: { name: action.dataStore, ...(title === undefined ? {} : { title }) },
                ...(callable ? {} : { unavailable: "data_store_missing" as const }),
                agentTool: revision.view === "published" && callable
              };
            }
            if (action.kind === "workflow") {
              // The rule of a call: the module is on. Whether the Workflow is published is asked
              // by the start; whether the reader may start it, `policy` says.
              const { callable } = await appActionDefinition(environment, host, action);
              return {
                ...listed,
                kind: action.kind,
                workflow: { name: action.workflow },
                ...(callable ? {} : { unavailable: "workflows_off" as const }),
                // No agent carries the start of a Workflow through an App yet.
                agentTool: false
              };
            }
            const connection = connections.get(action.connection);
            const unavailable = unavailableOf(action, connection);
            const target = agentTools.get(
              connectionOperationName(action.connection, action.operation)
            );
            return {
              ...listed,
              kind: action.kind,
              connection: {
                name: action.connection,
                ...(connection?.readable ? { title: connection.displayName } : {})
              },
              operation: action.operation,
              ...(unavailable === undefined ? {} : { unavailable }),
              // The rule of the tool source: an action that says it reads and stands for a
              // changing operation is no tool.
              agentTool:
                revision.view === "published" &&
                target !== undefined &&
                !(target === "changing" && action.effect === "reading")
            };
          })
        )
      });
    }
    return { apps, truncated };
  }

  /**
   * Where the reader's next call of each action of a draft goes, by the rule of the call path
   * (`draftCallTarget`) and the reader's own "Run live once" switches of that revision: a
   * switch somebody else set covers no call of the reader's. Nothing for a published revision.
   */
  private async draftTargets(
    reader: AuthenticatedIdentity,
    revision: ListedRevision
  ): Promise<((action: CompiledAppAction) => AppAction["target"]) | undefined> {
    if (revision.view !== "draft") return undefined;
    // The reader's own switches on the current draft: an App's call deletes the one it uses.
    const switches = await this.options.stores.liveOnceSwitches.list({
      clientInstanceId: this.options.clientInstanceId,
      assetId: revision.asset.id,
      switchedBy: reader.id
    });
    const mine = new Set(
      switches.flatMap((set) =>
        set.revisionId === revision.revisionId && set.usedByRunId === undefined ? [set.part] : []
      )
    );
    return (action) => draftCallTarget({ effect: action.effect, liveOnce: mine.has(action.name) });
  }

  private app(name: string): Promise<ConfigAssetRecord | undefined> {
    return this.options.stores.configAssets.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name
    });
  }

  /** Each Connection the actions name, read once. */
  private async connections(
    access: ActorAccess,
    actions: readonly CompiledAppAction[]
  ): Promise<Map<string, ConnectionFacts>> {
    const names = [
      ...new Set(
        actions.flatMap((action) => (action.kind === "connection" ? [action.connection] : []))
      )
    ];
    const read = await Promise.all(
      names.map(async (name) => {
        const asset = await this.options.stores.configAssets.getConfigAsset({
          clientInstanceId: this.options.clientInstanceId,
          kind: CONNECTION_ASSET_KIND,
          name
        });
        const facts = connectionFactsSchema.safeParse(asset?.config);
        if (!asset || asset.status !== "active" || !facts.success) return [];
        const readable = access.authorize(CONNECTION_ACTIONS.read, {
          kind: CONNECTION_ASSET_KIND,
          assetId: asset.id,
          name: asset.name
        }).allowed;
        return [[name, { ...facts.data, readable }] as const];
      })
    );
    return new Map(read.flat());
  }

  /** The title of each Data Store the actions name that the reader may read, read once. */
  private async dataStoreTitles(
    access: ActorAccess,
    actions: readonly CompiledAppAction[]
  ): Promise<Map<string, string>> {
    const names = [
      ...new Set(actions.flatMap((action) => (action.kind === "sql" ? [action.dataStore] : [])))
    ];
    const read = await Promise.all(
      names.map(async (name) => {
        const asset = await this.options.stores.configAssets.getConfigAsset({
          clientInstanceId: this.options.clientInstanceId,
          kind: DATA_STORE_ASSET_KIND,
          name
        });
        const title = storeTitleSchema.safeParse(asset?.publishedConfig);
        const readable =
          asset?.status === "active" &&
          access.authorize(DATA_STORE_ACTIONS.read, {
            kind: DATA_STORE_ASSET_KIND,
            assetId: asset.id,
            name,
            ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
          }).allowed;
        return readable && title.success ? [[name, title.data.title] as const] : [];
      })
    );
    return new Map(read.flat());
  }

  /**
   * The Connection operations an agent can carry now, each with its effect, as the
   * Connections say it. Asked only where a published revision is listed: no agent carries an
   * action of a draft.
   */
  private async agentTools(
    revisions: readonly ListedRevision[]
  ): Promise<Map<string, (typeof OPERATION_EFFECTS)[number]>> {
    const { connections } = this.options;
    if (!connections || revisions.every((revision) => revision.view === "draft")) {
      return new Map();
    }
    // Whether an operation is a tool is no fact of the Connection's page: it is told of
    // every Connection an App the caller reads names.
    const listed = await connections.listTools(() => true);
    return new Map(
      listed.connections.flatMap((connection) =>
        connection.tools.map((tool) => [tool.toolName, tool.effect] as const)
      )
    );
  }
}

/** The App with its workspace as a right is decided on it. */
function scoped(asset: ConfigAssetRecord): { id: string; name: string; workspaceId?: string } {
  return {
    id: asset.id,
    name: asset.name,
    ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
  };
}
