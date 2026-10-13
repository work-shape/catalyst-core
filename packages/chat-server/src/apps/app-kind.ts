import { APP_ASSET_KIND } from "@vivd-catalyst/api-contract";

export { APP_ASSET_KIND };

import {
  PAGE_MANIFEST_FILE,
  compiledActionsOf,
  declaredDataStoresOf
} from "@vivd-catalyst/app-build";
import {
  CONNECTION_ASSET_KIND,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  dataStoreRefusalError,
  defineAssetKind,
  type ActorAccess,
  type AssetScope,
  type AssetValidationIssue,
  type ClientInstanceId,
  type JsonObject,
  type PlatformStores
} from "@vivd-catalyst/core";
import { z } from "zod";
import { readDefinitionName, type WorkflowAssetKind } from "../asset-kinds/shared";
import { unlistedDataStore } from "./action-kinds";

/** The id of an App: what its manifest calls `id`. Unique on the instance. */
export const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export const APP_NAME_MAX_LENGTH = 63;
const APP_NAME_RULE = "lowercase letters, digits and '-', at most 63 characters";
/** How long the name people read may be. The same as the manifest's `name`. */
export const APP_TITLE_MAX_CHARS = 120;

export const APP_ACTIONS = {
  read: "app.read",
  write: "app.write",
  delete: "app.delete",
  publish: "app.publish",
  use: "app.use"
} as const;

/**
 * What a revision of an App holds as its config: the id the asset is addressed by, what people
 * read as its name, and the manifest as the build validated it. The files are the revision's
 * file set. The manifest is read here for what this kind checks and kept as the build wrote
 * it: a stored manifest of an earlier kit version stays readable.
 */
const appConfigSchema = z.strictObject({
  name: z.string(),
  title: z.string().min(1).max(APP_TITLE_MAX_CHARS),
  description: z.string().max(2000).optional(),
  manifest: z.looseObject({ connections: z.array(z.string()).optional() })
});

/** The config of a revision, from the manifest a build validated. */
export function appConfigOf(input: {
  name: string;
  title?: string;
  manifest: JsonObject;
}): JsonObject {
  const { name: displayName, description } = input.manifest;
  const title = input.title ?? (typeof displayName === "string" ? displayName : input.name);
  return {
    name: input.name,
    title: title.slice(0, APP_TITLE_MAX_CHARS),
    ...(typeof description === "string" ? { description } : {}),
    manifest: input.manifest
  };
}

const connectionNamesSchema = z.object({
  manifest: z.object({ connections: z.array(z.string()) })
});

/** The Connections the manifest of a revision's config names. */
function appConnectionNames(config: unknown): string[] {
  const read = connectionNamesSchema.safeParse(config);
  return read.success ? read.data.manifest.connections : [];
}

const manifestOfConfigSchema = z.object({ manifest: z.unknown() });
const connectionOperationsSchema = z.object({
  operations: z.array(z.object({ name: z.string(), effect: z.string() }))
});

/**
 * What a manifest names that the instance does not hold, one issue per name: a Connection, a
 * Data Store, an operation a Connection does not accept, and an action that says it reads
 * where the operation it stands for changes something. The build knows no Connection and no
 * Data Store, so this is where a manifest is held against what it names. A definition is read
 * against the assets its writer may read, so a store the writer may not read is none here.
 */
function findAppReferenceIssues(
  config: unknown,
  connections: readonly unknown[],
  dataStores: readonly unknown[]
): AssetValidationIssue[] {
  const known = new Map(
    connections.map((connection) => [readDefinitionName(connection), connection])
  );
  const manifest = manifestOfConfigSchema.safeParse(config);
  const stores = new Set(dataStores.map(readDefinitionName));
  const issues: AssetValidationIssue[] = [
    ...appConnectionNames(config)
      .filter((name) => !known.has(name))
      .map((name) => ({
        message: `The manifest names the Connection '${name}', which does not exist on this instance`,
        path: ["manifest", "connections"]
      })),
    ...(manifest.success ? declaredDataStoresOf(manifest.data.manifest) : [])
      .filter(({ name }) => !stores.has(name))
      .map(({ name }) => ({
        message: `The manifest names the Data Store '${name}', which does not exist on this instance`,
        path: ["manifest", "dataStores"]
      }))
  ];
  for (const action of manifest.success ? compiledActionsOf(manifest.data.manifest) : []) {
    // A statement on a Data Store names nothing but its store, which is held above.
    if (action.kind !== "connection") continue;
    const connection = connectionOperationsSchema.safeParse(known.get(action.connection));
    // A Connection that is missing is named above, once.
    if (!connection.success) continue;
    const operation = connection.data.operations.find(
      (candidate) => candidate.name === action.operation
    );
    if (!operation) {
      issues.push({
        message: `The action '${action.name}' calls the operation '${action.operation}' of the Connection '${action.connection}', which that Connection does not accept`,
        path: ["manifest", "actions"]
      });
    } else if (operation.effect === "changing" && action.effect === "reading") {
      issues.push({
        message: `The action '${action.name}' is declared reading and the operation '${action.operation}' of the Connection '${action.connection}' changes something. Declare the action changing.`,
        path: ["manifest", "actions"]
      });
    }
  }
  return issues;
}

/** The right on a Data Store an `sql` action of each effect uses. */
const STORE_RIGHT_OF_EFFECT = {
  reading: DATA_STORE_ACTIONS.read,
  changing: DATA_STORE_ACTIONS.insert
} as const;

/**
 * What a publish of an App answers for. The right to a Data Store is checked on the App and
 * not of each person who uses it (data-stores-and-knowledge-bases.md, Scope): whoever may use
 * the published App reads and adds what its `sql` actions read and add. So the publish is
 * where the right is asked, of the publisher: `data_store.read` on a listed store the
 * revision's reading actions reach and `data_store.insert` on one its changing actions reach.
 * Nothing is written for it: the published pointer of the App is the record, and a call of a
 * published action is admitted by it.
 *
 * The publish is refused as well for a store the App cannot reach as its users will: one that
 * is not published, was deleted or belongs to another workspace, and one below the migration
 * level the manifest asks for. Two point reads per listed store, in the transaction of the
 * publish.
 */
async function requireDataStores(input: {
  clientInstanceId: ClientInstanceId;
  access: ActorAccess;
  scope: AssetScope;
  config: JsonObject;
  stores: PlatformStores;
}): Promise<void> {
  const { clientInstanceId, access, scope, stores } = input;
  const listed = declaredDataStoresOf(input.config.manifest);
  const actions = compiledActionsOf(input.config.manifest).flatMap((action) =>
    action.kind === "sql" ? [action] : []
  );
  for (const action of actions) {
    const unlisted = unlistedDataStore(listed, action);
    if (unlisted) throw unlisted;
  }
  for (const { name, minSchema } of listed) {
    const asset = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name
    });
    const record =
      asset?.status === "active" && asset.publishedRevisionId !== undefined
        ? await stores.dataStores.getDataStore({ clientInstanceId, id: asset.id })
        : undefined;
    const inScope =
      asset?.scope.kind !== "workspace" ||
      (scope.kind === "workspace" && asset.scope.workspaceId === scope.workspaceId);
    if (!record || record.status === "retired" || !inScope) {
      throw dataStoreRefusalError("data_store_unavailable", name);
    }
    if (minSchema !== undefined && record.level < minSchema) {
      throw dataStoreRefusalError("data_store_below_min_schema", name, {
        minSchema,
        level: record.level
      });
    }
    const resource = {
      kind: DATA_STORE_ASSET_KIND,
      assetId: record.id,
      name,
      ...(asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    };
    for (const action of actions) {
      if (action.dataStore === name) {
        access.require(STORE_RIGHT_OF_EFFECT[action.effect], resource);
      }
    }
  }
}

/**
 * The App kind: a set of files a workspace's members open, with a draft and a published
 * revision. A write moves the draft, and nobody but its writers is shown it. It belongs to one
 * workspace, is no part of the release bundle and holds no instance default.
 */
export function createAppAssetKind(): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: APP_ASSET_KIND,
      plural: "apps",
      schema: appConfigSchema,
      nameRule: {
        pattern: APP_NAME_PATTERN,
        maxLength: APP_NAME_MAX_LENGTH,
        description: APP_NAME_RULE
      },
      actions: APP_ACTIONS,
      lifecycle: "draft_published",
      representation: "files",
      manifestFile: PAGE_MANIFEST_FILE,
      // The files of an App are a repository. Until its writes commit to it, a revision
      // holds a file set as before; one that has a commit holds both.
      content: "repository",
      owners: ["workspace"],
      validate: () => [],
      // Asked for the Apps a write adds or changes only: a stored App that names a Connection
      // a later release no longer seeds never stands in the way of a write to another asset.
      // A publish asks the same of the revision it names.
      validateWrite: (context, apps) =>
        apps
          .filter((app) => context.changes(APP_ASSET_KIND, app.name))
          .flatMap((app) =>
            findAppReferenceIssues(
              app,
              context.definitions(CONNECTION_ASSET_KIND),
              context.definitions(DATA_STORE_ASSET_KIND)
            )
          ),
      summarize: (app) => ({
        name: app.name,
        title: app.title,
        ...(app.description === undefined ? {} : { description: app.description })
      })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    onPublish: requireDataStores,
    // A write from files reads the name people see from the manifest. A manifest that names
    // none keeps the one the App was made with.
    configOfFiles: ({ name, manifest, current }) =>
      appConfigOf({
        name,
        manifest,
        ...(typeof manifest.name !== "string" && typeof current?.title === "string"
          ? { title: current.title }
          : {})
      })
  };
}
