import type {
  ActorAccess,
  OperationDefinition,
  OperationSourceKind,
  OperationSourceView
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { accessResource } from "../assets/asset-access";
import { operationTarget } from "../publish-narrative/narrative-facts";
import type { AssetWorkflowOptions } from "../types";

// What an operation belongs to, as the reader may be told it: the Workflow's step facts and the
// listing of callable operations (WF-EDIT-3) tell it the same way. A source the reader may not
// read is told by its kind alone.

const sourceConfigSchema = z.object({
  title: z.string().optional(),
  displayName: z.string().optional(),
  service: z.string().optional(),
  manifest: z.object({ name: z.string().optional() }).optional()
});

/** The source an operation's name names, by kind and name. */
function operationSourceOf(name: string): { kind: OperationSourceKind; name?: string } {
  // An operation of one Knowledge Base or Workflow is `<prefix>.<name>.<verb>`; a name of two
  // parts, such as the tool `knowledge.search`, is an operation of the release.
  const target = operationTarget(name);
  if (target.kind === "connection") return { kind: "connection", name: target.connection };
  if (target.kind === "data_store") return { kind: "data_store", name: target.store };
  const parts = name.split(".");
  if (parts.length >= 3 && parts[1]) {
    if (parts[0] === "knowledge") return { kind: "knowledge_base", name: parts[1] };
    if (parts[0] === "workflow") return { kind: "workflow", name: parts[1] };
  }
  return { kind: "other" };
}

export interface ReadSource {
  source: OperationSourceView;
  readable: boolean;
  published?: boolean;
}

/** Reads each named source once, under the reader's rights. */
export function sourceReader(options: AssetWorkflowOptions, access: ActorAccess) {
  const sources = new Map<string, Promise<ReadSource>>();
  return function read(kind: OperationSourceKind, name: string): Promise<ReadSource> {
    const key = `${kind}:${name}`;
    let pending = sources.get(key);
    if (!pending) {
      pending = (async (): Promise<ReadSource> => {
        const asset = await options.configAssets.store.getConfigAsset({
          clientInstanceId: options.clientInstanceId,
          kind,
          name
        });
        const resource = asset ? accessResource(kind, name, asset.scope, asset.id) : { kind, name };
        const readable = access.authorize(`${kind}.read`, resource).allowed;
        if (!readable) return { source: { kind }, readable: false };
        if (asset?.status !== "active")
          return { source: { kind }, readable: true, published: false };
        const config = sourceConfigSchema.safeParse(asset.publishedConfig ?? asset.config).data;
        const title = config?.displayName ?? config?.manifest?.name ?? config?.title ?? name;
        return {
          source: { kind, title, ...(config?.service ? { service: config.service } : {}) },
          readable: true,
          published: asset.publishedRevision !== undefined
        };
      })();
      sources.set(key, pending);
    }
    return pending;
  };
}

/** The source of an operation, as the reader may be told it. */
export async function readOperationSource(
  read: ReturnType<typeof sourceReader>,
  operation: string
): Promise<ReadSource> {
  const { kind, name } = operationSourceOf(operation);
  return kind !== "other" && name ? read(kind, name) : { source: { kind }, readable: true };
}

/** An operation's title: its own, else its last name part in words. */
export function operationTitle(definition: Pick<OperationDefinition, "name" | "title">): string {
  const name = definition.name;
  return definition.title ?? name.split(".").at(-1)?.replaceAll("_", " ") ?? name;
}
