import { createSkillRevisionPreview, skillConfigSchema } from "@vivd-catalyst/config-schema";
import {
  INSTANCE_ASSET_SCOPE,
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
} from "@vivd-catalyst/core";
import { z } from "zod";
import { accessResource } from "./asset-access";

/** The operation whose held call is shown as the asset it saves. */
export const HELD_ASSET_OPERATION = "assets.put";

/** The kind whose content the preview shows. Every other kind is named and nothing more. */
const SKILL_KIND = "skill";

const inputSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  expectedRevision: z.number().optional(),
  workspaceId: z.string().min(1).optional()
});

interface HeldAssetPreviewOptions {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "getConfigAsset">;
  kinds: AssetKindRegistry;
  namespaces: Pick<AccessAdministrationStore, "listNamespaceRecords">;
  modules: ModuleSnapshot;
}

/** What a held `assets.put` saves, for the person who decides it. */
interface HeldAssetPreview {
  kind: string;
  name: string;
  title: string;
  /** The registered prefix the name starts with, for an asset of the instance's own. */
  namespace?: string;
  /** No asset of the name exists: approving creates it. */
  isNew: boolean;
  /** A skill's text: all of it for a new one, otherwise what differs from the stored one. */
  content?: ReturnType<typeof createSkillRevisionPreview>;
  /** A skill's description as the call saves it. */
  description?: string;
  /** The stored title and description, each where the call changes it. */
  previous?: { title?: string; description?: string };
  /** The resources the stored skill has and the call leaves out. */
  removedResources?: string[];
  /** The reader may not read the stored skill, so the preview compares nothing with it. */
  beforeWithheld?: true;
}

export type HeldAssetPreviewer = (
  input: JsonValue,
  viewer: ApprovalPreviewViewer | undefined
) => Promise<HeldAssetPreview | undefined>;

/**
 * Describes the asset a held `assets.put` saves. It answers nothing for an input it cannot
 * read, a kind nothing registered or a kind of a module that is off: the call is then shown
 * as any other.
 *
 * What it reads. For a row of a list: the Namespace records of the instance, once for the
 * whole list, and no asset. Whether the call creates is then read from the call itself, which
 * names the revision it replaces. For one opened request: the Namespace records and the one
 * asset the call names.
 *
 * What it shows of the stored asset. Whether it exists, to everyone who sees the request. Its
 * text, title, description and resource names only to a reader the kind's read right allows
 * on that asset, asked of the same resolver with the same resource as `assets.get`. Everything
 * else in the preview comes from the input, which the request already carries.
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

  return async (input, viewer) => {
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
      title: titleOf(kind, config) ?? name,
      ...(namespace ? { namespace } : {})
    };
    if (!viewer || viewer.inList) {
      return { ...named, isNew: expectedRevision === undefined };
    }

    const row = await options.store.getConfigAsset({ clientInstanceId, kind: kind.kind, name });
    const stored =
      row && row.status === "active" && assetScopesEqual(row.scope, scope) ? row : undefined;
    const next = kind.kind === SKILL_KIND ? skillConfigSchema.safeParse(config) : undefined;
    if (!next?.success) return { ...named, isNew: stored === undefined };
    const preview: HeldAssetPreview = {
      ...named,
      isNew: stored === undefined,
      description: next.data.description
    };
    if (!stored) {
      return { ...preview, content: createSkillRevisionPreview(undefined, next.data) };
    }
    const current = skillConfigSchema.safeParse(stored.config);
    const mayRead = viewer.access.authorize(
      kind.actions.read,
      accessResource(kind.kind, name, scope, stored.id)
    ).allowed;
    if (!mayRead || !current.success) {
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
