import { createSkillRevisionPreview, skillConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  INSTANCE_ASSET_SCOPE,
  SKILL_CHANGE_TYPES,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  findNamespaceOfAssetName,
  isAppError,
  type AccessAdministrationStore,
  type ApprovalPreviewViewer,
  type AssetKindRegistry,
  type AssetScope,
  type ClientInstanceId,
  type ConfigAssetStore,
  type JsonValue,
  type ModuleSnapshot,
  type Namespace
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { accessResource } from "../assets/asset-access";

/** The operation whose held call is shown as the asset it saves. */
export const HELD_ASSET_OPERATION = "assets.put";

/** The kind whose content the preview shows. Every other kind is named and nothing more. */
const SKILL_KIND = "skill";

const inputSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  // `null` creates the asset. A call that was held before the revision was required has none.
  expectedRevision: z.number().nullable().optional(),
  workspaceId: z.string().min(1).optional()
});

interface HeldAssetPreviewOptions {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "getConfigAsset" | "getConfigAssetRevision">;
  kinds: AssetKindRegistry;
  namespaces: Pick<AccessAdministrationStore, "listNamespaceRecords">;
  modules: ModuleSnapshot;
}

/** What a held `assets.put` saves, for the person who decides it. */
interface HeldAssetPreview {
  kind: string;
  name: string;
  title: string;
  workspaceId?: string;
  /** The registered prefix the name starts with, for an asset of the instance's own. */
  namespace?: string;
  /**
   * Approving creates the asset. Present only when the viewer may read the target, or for
   * a list row whose existence claim comes from the submitted call.
   */
  isNew?: boolean;
  /** Stored only: what the frozen call said about existence for list rows. */
  requestedNew?: boolean;
  /** Stored only: the revision the requester saw, `null` for a creation. */
  requestedRevision?: number | null;
  /** A skill's text: all of it for a new one, otherwise what differs from the stored one. */
  content?: ReturnType<typeof createSkillRevisionPreview>;
  /** A skill's description as the call saves it. */
  description?: string;
  /** The stored title and description, each where the call changes it. */
  previous?: { title?: string; description?: string };
  /** The resources the stored skill has and the call leaves out. */
  removedResources?: string[];
  /** The call changes a skill whose stored text the reader is not shown: nothing is compared. */
  beforeWithheld?: true;
  /** The frozen revision no longer matches: approving cannot apply this change. */
  isStale?: boolean;
}

export type HeldAssetPreviewer = (
  input: JsonValue,
  viewer: ApprovalPreviewViewer | undefined,
  frozen?: HeldAssetPreview
) => Promise<HeldAssetPreview | undefined>;

/**
 * Describes the asset a held `assets.put` saves. It answers nothing for an input it cannot
 * read, a kind nothing registered or a kind of a module that is off: the call is then shown
 * as any other.
 *
 * What it reads. For a row of a list: the Namespace records of the instance, once for the
 * whole list, and no asset. Whether the call creates is then read from the call itself, which
 * names the revision it replaces. For one opened request: the Namespace records and the one
 * asset the call names and, for a stale skill change, the revision the requester read.
 *
 * What it shows of the stored asset. Whether it exists, its text, title, description and
 * resource names only to a reader the kind's read right allows on that asset, asked of the same
 * resolver with the same resource as `assets.get`. Every other reader is shown what the input
 * alone says, as a row of a list is: no field and no shape of the answer depends on the stored
 * asset.
 */
export function createHeldAssetPreviewer(options: HeldAssetPreviewOptions): HeldAssetPreviewer {
  const { clientInstanceId } = options;
  const namespacesOfList = new WeakMap<ApprovalPreviewViewer, Promise<Namespace[]>>();
  const namespaces = (viewer: ApprovalPreviewViewer | undefined): Promise<Namespace[]> => {
    const read = () => options.namespaces.listNamespaceRecords({ clientInstanceId });
    if (!viewer) return read();
    const known = namespacesOfList.get(viewer) ?? read();
    namespacesOfList.set(viewer, known);
    return known;
  };

  return async (input, viewer, frozen) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const { name, config, expectedRevision, workspaceId } = parsed.data;
    const kind = options.kinds.get(parsed.data.kind);
    if (!kind || options.modules.offModuleOf("kind", kind.kind) !== undefined) return undefined;

    const scope: AssetScope =
      workspaceId === undefined
        ? INSTANCE_ASSET_SCOPE
        : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(workspaceId) };
    // A Namespace is a prefix among the instance's own assets: a workspace's have none.
    const namespace =
      scope.kind === "instance"
        ? findNamespaceOfAssetName(await namespaces(viewer), name)?.prefix
        : undefined;
    const named = {
      kind: kind.kind,
      name,
      title: frozen?.title ?? titleOf(kind, config) ?? name,
      ...(workspaceId ? { workspaceId } : {}),
      ...(namespace ? { namespace } : {})
    };
    if (!viewer || viewer.inList) {
      return {
        ...named,
        isNew: frozen ? (frozen.requestedNew ?? false) : (expectedRevision ?? null) === null
      };
    }

    // The right is asked before anything is told of the stored asset, with the resource
    // `assets.get` asks it with: the row of this scope, deleted or not, carries the id.
    const row = await options.store.getConfigAsset({ clientInstanceId, kind: kind.kind, name });
    const inScope = row && assetScopesEqual(row.scope, scope) ? row : undefined;
    const mayRead = viewer.access.authorize(
      kind.actions.read,
      accessResource(kind.kind, name, scope, inScope?.id)
    ).allowed;
    // Only the submitted title identifies a held change to a non-reader. Neither a stored
    // comparison nor its shape (creation, change kinds or resource targets) is disclosed.
    if (!mayRead) return { ...named, beforeWithheld: true };
    const stored = inScope?.status === "active" ? inScope : undefined;
    if (frozen) {
      const {
        requestedNew: _requestedNew,
        requestedRevision: _requestedRevision,
        beforeWithheld: _withheld,
        ...retained
      } = frozen;
      return { ...retained, ...named };
    }
    const isNew = stored === undefined;
    const staleness =
      expectedRevision !== undefined && (stored?.revision ?? null) !== expectedRevision
        ? { isStale: true }
        : {};
    const next = kind.kind === SKILL_KIND ? skillConfigSchema.safeParse(config) : undefined;
    if (!next?.success) return { ...named, isNew, ...staleness };
    const preview: HeldAssetPreview = {
      ...named,
      isNew,
      description: next.data.description,
      ...staleness
    };
    if (isNew) {
      return { ...preview, content: createSkillRevisionPreview(undefined, next.data) };
    }
    // A pending request is compared with what its requester read, not a newer save that
    // approving this request cannot overwrite. The same current-asset read right guards history.
    const baseline =
      preview.isStale && expectedRevision !== undefined && expectedRevision !== null
        ? await options.store.getConfigAssetRevision({
            clientInstanceId,
            kind: kind.kind,
            name,
            revision: expectedRevision
          })
        : stored;
    const current = baseline ? skillConfigSchema.safeParse(baseline.config) : undefined;
    if (!current?.success) {
      return {
        ...preview,
        beforeWithheld: true,
        content: {
          skillName: name,
          skillTitle: next.data.title,
          isNewSkill: false,
          changes: [
            { type: "replace", target: "root", after: next.data.content },
            ...(next.data.resources ?? []).map((resource) => ({
              type: "replace" as const,
              target: resource.path,
              after: resource.content
            }))
          ]
        }
      };
    }
    const previous = {
      ...(current.data.title === next.data.title ? {} : { title: current.data.title }),
      ...(current.data.description === next.data.description
        ? {}
        : { description: current.data.description })
    };
    const kept = new Set((next.data.resources ?? []).map((resource) => resource.path));
    const removedResources = (current.data.resources ?? [])
      .map((resource) => resource.path)
      .filter((path) => !kept.has(path));
    return {
      ...preview,
      content: createSkillRevisionPreview(current.data, next.data),
      ...(Object.keys(previous).length > 0 ? { previous } : {}),
      ...(removedResources.length > 0 ? { removedResources } : {})
    };
  };
}

/** Reads only the preview fields this server wrote; no executable input survives here. */
export const heldAssetPreviewSchema = z.object({
  kind: z.string(),
  name: z.string(),
  title: z.string(),
  workspaceId: z.string().optional(),
  isNew: z.boolean().optional(),
  requestedNew: z.boolean().optional(),
  requestedRevision: z.number().nullable().optional(),
  description: z.string().optional(),
  previous: z
    .object({ title: z.string().optional(), description: z.string().optional() })
    .optional(),
  removedResources: z.array(z.string()).optional(),
  beforeWithheld: z.literal(true).optional(),
  content: z
    .object({
      skillName: z.string(),
      skillTitle: z.string(),
      isNewSkill: z.boolean(),
      changes: z.array(
        z.object({
          type: z.enum(SKILL_CHANGE_TYPES),
          target: z.string(),
          sectionHeading: z.string().optional(),
          before: z.string().optional(),
          after: z.string()
        })
      ),
      newSkill: z
        .object({
          name: z.string(),
          title: z.string(),
          description: z.string(),
          content: z.string()
        })
        .optional()
    })
    .optional()
});

/** The title the kind reads from a definition. Nothing for one its schema refuses. */
function titleOf(
  kind: { summarize(definition: unknown): { title: string } },
  config: unknown
): string | undefined {
  try {
    return kind.summarize(config).title;
  } catch (error) {
    if (isAppError(error) && error.code === "VALIDATION_FAILED") return undefined;
    throw error;
  }
}

/** Checks the frozen revision in the decision's transaction without applying anything. */
export async function heldAssetIsStale(
  input: JsonValue,
  store: Pick<ConfigAssetStore, "getConfigAsset">,
  clientInstanceId: ClientInstanceId
): Promise<boolean> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || parsed.data.expectedRevision === undefined) return false;
  const row = await store.getConfigAsset({
    clientInstanceId,
    kind: parsed.data.kind,
    name: parsed.data.name
  });
  const scope: AssetScope =
    parsed.data.workspaceId === undefined
      ? INSTANCE_ASSET_SCOPE
      : {
          kind: "workspace",
          workspaceId: asCollaborationWorkspaceId(parsed.data.workspaceId)
        };
  const revision =
    row?.status === "active" && assetScopesEqual(row.scope, scope) ? row.revision : null;
  return revision !== parsed.data.expectedRevision;
}

/** The revision the frozen call was made against: `null` creates, none for an older call. */
export function heldAssetRequestedRevision(input: JsonValue): number | null | undefined {
  const parsed = inputSchema.safeParse(input);
  return parsed.success ? parsed.data.expectedRevision : undefined;
}

/** What the frozen call itself says about existence, without reading the stored asset. */
export function heldAssetRequestedNew(input: JsonValue): boolean | undefined {
  const parsed = inputSchema.safeParse(input);
  return parsed.success ? (parsed.data.expectedRevision ?? null) === null : undefined;
}
