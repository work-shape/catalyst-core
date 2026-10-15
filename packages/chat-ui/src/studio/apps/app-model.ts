import {
  ApiError,
  type AssetSummary,
  type CollaborationWorkspaceAgents,
  type PlatformContext
} from "@work-shape/catalyst-api-client";
import type { TranslationKey } from "../../shared/i18n";

/** The four rights of an App, by the names the instance decides them under. */
export const APP_RIGHT_NAMES = {
  read: "app.read",
  write: "app.write",
  publish: "app.publish",
  delete: "app.delete"
} as const;

/**
 * What the reader may do with the Apps of a workspace, as far as the browser can know it.
 * Opening a published App needs none of these: every member of the App's workspace may.
 */
export interface AppRights {
  /** Reads an App's record: its name, its description, its manifest and its revisions. */
  read: boolean;
  write: boolean;
  publish: boolean;
  delete: boolean;
}

export const NO_APP_RIGHTS: AppRights = {
  read: false,
  write: false,
  publish: false,
  delete: false
};

/**
 * The reader's rights on Apps, from what the instance says the reader holds on every asset of
 * the kind. This is the one place the interface decides what it offers: a right that is
 * granted per workspace (AP-3) is added here and nowhere else. The instance decides every
 * call itself.
 */
export function resolveAppRights(context: Pick<PlatformContext, "actions"> | undefined): AppRights {
  const held = context?.actions ?? [];
  return {
    read: held.includes(APP_RIGHT_NAMES.read),
    write: held.includes(APP_RIGHT_NAMES.write),
    publish: held.includes(APP_RIGHT_NAMES.publish),
    delete: held.includes(APP_RIGHT_NAMES.delete)
  };
}

/**
 * Whether the Apps row of the sidebar shows: the module is on and the instance says the row is
 * there for the person in the open workspace, which it does where the Apps page lists them an
 * App or they may write one there. A member is never shown an empty row; a builder is, so the
 * first App has a place to go. Unknown counts as none until the workspace's list arrived.
 */
export function appsRowShown(
  enabled: boolean,
  list: Pick<CollaborationWorkspaceAgents, "visibleSections"> | undefined
): boolean {
  return enabled && list?.visibleSections.includes("apps") === true;
}

/**
 * Whether the reader builds Apps here: writes them or publishes them. Everybody else uses an
 * App, and is not shown what only its builders work with: its id and its revision numbers.
 */
export function appBuilder(rights: Pick<AppRights, "write" | "publish">): boolean {
  return rights.write || rights.publish;
}

/**
 * Whether the instance showed this reader the draft of an App. Whoever may not read the draft
 * is answered the published view, which names no draft: nothing of a draft is offered then.
 */
export function appDraftShown(app: Pick<AssetSummary, "draftRevision"> | undefined): boolean {
  return app?.draftRevision !== undefined;
}

/** Where an App stands: what its users are served, and whether its draft is ahead of that. */
export type AppState =
  { kind: "published"; revision: number; draftAhead: boolean } | { kind: "draft_only" };

export function appState(
  app: Pick<AssetSummary, "revision" | "draftRevision" | "publishedRevision">
): AppState {
  if (app.publishedRevision === undefined) {
    return { kind: "draft_only" };
  }
  return {
    kind: "published",
    revision: app.publishedRevision,
    // A view without a draft is the published one: nothing is ahead of it for this reader.
    draftAhead: app.draftRevision !== undefined && app.draftRevision !== app.publishedRevision
  };
}

/** The number of the revision a writer edits. */
export function appDraftRevision(app: Pick<AssetSummary, "revision" | "draftRevision">): number {
  return app.draftRevision ?? app.revision;
}

/** What a row of the Apps list offers, in the order of its menu. */
export type AppRowAction = "open" | "edit" | "details" | "copy_link" | "delete";

/**
 * The actions of one App for this reader. An action the reader may not take is absent. An App
 * without a published revision has nothing to open and no address its users could follow, and
 * a reader who was not shown the draft has none to edit.
 */
export function appRowActions(
  rights: AppRights,
  state: AppState,
  draftShown: boolean
): AppRowAction[] {
  const published = state.kind === "published";
  return [
    ...(published ? (["open"] as const) : []),
    ...(rights.write && draftShown ? (["edit"] as const) : []),
    ...(rights.read ? (["details"] as const) : []),
    ...(published ? (["copy_link"] as const) : []),
    ...(rights.delete ? (["delete"] as const) : [])
  ];
}

/** The id of an App as the instance accepts it: lowercase letters, digits and '-'. */
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const APP_ID_MAX = 63;
/** The longest name people read, as the instance accepts it. */
export const APP_NAME_MAX = 120;

/**
 * An id made from the name people read: its words in lowercase, joined by hyphens, without
 * what an id cannot hold. The reader can change it before the App is saved.
 */
export function appIdFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ß/gu, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, APP_ID_MAX)
    .replace(/-+$/u, "");
}

/**
 * The name people read of an App, from the config of its record: the title the build took
 * from the manifest. An App without one goes by its id.
 */
export function appTitle(app: { name: string; config: unknown } | undefined, id: string): string {
  const title = field(app?.config, "title");
  return (typeof title === "string" ? title.trim() : "") || app?.name || id;
}

/** What the config of an App says it is for, if it says so. */
export function appDescription(config: unknown): string | undefined {
  const description = field(config, "description");
  return typeof description === "string" && description.trim() !== ""
    ? description.trim()
    : undefined;
}

/** What the manifest of a revision names that a person decides about before publishing. */
export interface AppManifestSummary {
  connections: string[];
  actions: string[];
  hosts: string[];
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The Connections, actions and external hosts in the config of one App revision. The manifest
 * is kept as its build wrote it, so nothing here trusts its shape.
 */
export function appManifestSummary(config: unknown): AppManifestSummary {
  const manifest = field(config, "manifest");
  const actions = field(manifest, "actions");
  return {
    connections: texts(field(manifest, "connections")),
    actions: (Array.isArray(actions) ? actions : []).flatMap((action: unknown) => {
      const name = field(action, "name");
      return typeof name === "string" ? [name] : [];
    }),
    hosts: texts(field(manifest, "externalHosts"))
  };
}

/** What stands in place of an App that is not shown. */
export type AppPreviewProblem =
  /** The App is there and nothing of it has been published. */
  | "not_published"
  /** There is no such App, or none for this reader. */
  | "unavailable"
  | "kit_unavailable"
  | "file_set_unknown"
  | "failed";

/** The reason a refusal of the instance names, read from an answer nobody vouches for. */
function refusalReason(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const reason = field(field(field(error.payload, "error"), "details"), "reason");
  return typeof reason === "string" ? reason : undefined;
}

/**
 * The sentence for a refusal the Apps area knows by its reason. Everything else is shown as
 * the instance said it.
 */
export function appRefusalText(error: unknown): TranslationKey | undefined {
  switch (refusalReason(error)) {
    case "revision_files_removed":
      return "apps.revisionFilesRemoved";
    case "input_too_large_to_hold":
      return "apps.tooLargeToHold";
    default:
      return undefined;
  }
}

/** Why the instance gave no address for a revision of an App. */
export function appPreviewProblem(error: unknown): AppPreviewProblem {
  const reason = refusalReason(error);
  if (reason === "not_published" || reason === "kit_unavailable" || reason === "file_set_unknown") {
    return reason;
  }
  return error instanceof ApiError && (error.status === 404 || error.status === 403)
    ? "unavailable"
    : "failed";
}

/** The sentence of each problem. The draft has its own for a reader who may not write. */
export function appPreviewProblemText(
  problem: AppPreviewProblem,
  mode: "published" | "draft"
): TranslationKey {
  switch (problem) {
    case "not_published":
      return "apps.notPublished";
    case "unavailable":
      return mode === "draft" ? "apps.draftUnavailable" : "apps.unavailable";
    case "kit_unavailable":
      return "apps.failedKit";
    case "file_set_unknown":
      return "apps.failedFileSet";
    case "failed":
      return "apps.failed";
  }
}

/** The first route of an App: where it starts when the address names no other. */
export const APP_START_ROUTE = "/";
