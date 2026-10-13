import { APP_ASSET_KIND } from "@vivd-catalyst/api-contract";

export { APP_ASSET_KIND };

import { PAGE_MANIFEST_FILE, compiledActionsOf } from "@vivd-catalyst/app-build";
import {
  CONNECTION_ASSET_KIND,
  defineAssetKind,
  type AssetValidationIssue,
  type JsonObject
} from "@vivd-catalyst/core";
import { z } from "zod";
import { readDefinitionName, type WorkflowAssetKind } from "../asset-kinds/shared";

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
 * What a manifest names that the instance does not hold, one issue per name: a Connection, an
 * operation a Connection does not accept, and an action that says it reads where the
 * operation it stands for changes something. The build knows no Connection, so this is where
 * an action is held against the operation it names.
 */
function findAppReferenceIssues(
  config: unknown,
  connections: readonly unknown[]
): AssetValidationIssue[] {
  const known = new Map(
    connections.map((connection) => [readDefinitionName(connection), connection])
  );
  const issues: AssetValidationIssue[] = appConnectionNames(config)
    .filter((name) => !known.has(name))
    .map((name) => ({
      message: `The manifest names the Connection '${name}', which does not exist on this instance`,
      path: ["manifest", "connections"]
    }));
  const manifest = manifestOfConfigSchema.safeParse(config);
  for (const action of manifest.success ? compiledActionsOf(manifest.data.manifest) : []) {
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
            findAppReferenceIssues(app, context.definitions(CONNECTION_ASSET_KIND))
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
