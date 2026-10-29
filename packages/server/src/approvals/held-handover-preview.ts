import {
  CONNECTION_ACTIONS,
  DATA_STORE_ACTIONS,
  KNOWLEDGE_BASE_ACTIONS,
  dataHandoverApprovalLines,
  dataHandoverSubjectPairs,
  type ApprovalPreviewViewer,
  type ClientInstanceId,
  type ConfigAssetStore,
  type JsonValue,
  type LocaleCode
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { accessResource } from "../assets/asset-access";

const titleSchema = z.object({ title: z.string().min(1) });
const displayNameSchema = z.object({ displayName: z.string().min(1) });

/**
 * What the opened Inbox item of a held call that hands a source's data on says to its reader
 * (DS-13c): the lines its caller was shown, each store and source by its title only where the
 * reader may see it, and that approving confirms the hand-over. Nothing in a list row, and
 * nothing for a call that hands nothing on.
 */
export async function heldHandoverLines(
  store: Pick<ConfigAssetStore, "getConfigAsset">,
  clientInstanceId: ClientInstanceId,
  subject: JsonValue | undefined,
  viewer: ApprovalPreviewViewer | undefined,
  locale: LocaleCode
): Promise<string[] | undefined> {
  const handover = dataHandoverSubjectPairs(subject);
  if (!handover || viewer?.inList !== false) return undefined;
  const { access } = viewer;
  /** The title of an asset where the reader holds one of `rights` on it. */
  const titleOf = async (
    kind: string,
    name: string,
    rights: readonly string[],
    read: (config: unknown) => string | undefined
  ): Promise<string | undefined> => {
    const asset = await store.getConfigAsset({ clientInstanceId, kind, name });
    if (asset?.status !== "active") return undefined;
    const resource = accessResource(asset.kind, asset.name, asset.scope, asset.id);
    if (!rights.some((right) => access.authorize(right, resource).allowed)) return undefined;
    return read(asset.publishedConfig ?? asset.config) ?? asset.name;
  };
  const pairs = await Promise.all(
    handover.pairs.map(async ({ store: held, connection, people }) => {
      const storeTitle = await titleOf(
        held.kind,
        held.name,
        held.kind === "data_store"
          ? [DATA_STORE_ACTIONS.read, DATA_STORE_ACTIONS.write]
          : [KNOWLEDGE_BASE_ACTIONS.use, KNOWLEDGE_BASE_ACTIONS.read, KNOWLEDGE_BASE_ACTIONS.write],
        (config) => titleSchema.safeParse(config).data?.title
      );
      const connectionTitle = await titleOf(
        "connection",
        connection.name,
        [CONNECTION_ACTIONS.read, CONNECTION_ACTIONS.use, CONNECTION_ACTIONS.write],
        (config) => displayNameSchema.safeParse(config).data?.displayName
      );
      return {
        store: { kind: held.kind, ...(storeTitle ? { title: storeTitle } : {}) },
        connection: connectionTitle ? { title: connectionTitle } : {},
        people
      };
    })
  );
  return dataHandoverApprovalLines({ pairs, truncated: handover.truncated }, locale);
}
