import { z } from "zod";
import type { ClientInstanceId, ConfigAssetStore } from "@vivd-catalyst/core";
import type { TestCallInput, TestOperationName } from "./operations";

const assetParamsSchema = z.object({ kind: z.string(), name: z.string() });
const payloadSchema = z.record(z.string(), z.unknown());

const syncPayloadSchema = z.object({ items: z.array(payloadSchema) }).loose();
const syncItemSchema = z.object({
  type: z.enum(["put", "delete"]),
  kind: z.string(),
  name: z.string().optional(),
  config: z.object({ name: z.string() }).loose().optional()
});

/**
 * A write of one asset, or a batch, as a caller makes it who read the assets just before: it
 * carries the revision each asset is at, a deleted one's included, and `null` for a put of a
 * name that was never stored. A test that is about the revision check names `expectedRevision`
 * itself, `undefined` included, and is left as it is. A delete or revert of an asset that
 * does not exist names revision 1, so the call is complete and is answered by what the test
 * is about.
 */
export async function atCurrentRevision(
  stores: { configAssets: ConfigAssetStore },
  clientInstanceId: ClientInstanceId,
  operation: TestOperationName,
  input: TestCallInput
): Promise<TestCallInput> {
  const revisionOf = async (type: "put" | "delete", kind: string, name: string) => {
    const asset = await stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
    return type === "put" ? (asset?.revision ?? null) : (asset?.revision ?? 1);
  };
  if (operation === "assets.sync" || operation === "assets.sync_check") {
    const batch = syncPayloadSchema.safeParse(input.payload);
    if (!batch.success) return input;
    const items = [];
    for (const item of batch.data.items) {
      const read = syncItemSchema.safeParse(item);
      const name = read.success ? (read.data.name ?? read.data.config?.name) : undefined;
      items.push(
        !read.success || name === undefined || "expectedRevision" in item
          ? item
          : { ...item, expectedRevision: await revisionOf(read.data.type, read.data.kind, name) }
      );
    }
    return { ...input, payload: { ...batch.data, items } };
  }
  if (
    operation !== "assets.put" &&
    operation !== "assets.delete" &&
    operation !== "assets.revert"
  ) {
    return input;
  }
  const payload = payloadSchema.safeParse(input.payload ?? {});
  const params = assetParamsSchema.safeParse(input.params);
  if (!payload.success || !params.success || "expectedRevision" in payload.data) {
    return input;
  }
  const { kind, name } = params.data;
  const expectedRevision = await revisionOf(
    operation === "assets.put" ? "put" : "delete",
    kind,
    name
  );
  return { ...input, payload: { ...payload.data, expectedRevision } };
}

interface ReleaseContent {
  agents?: ReadonlyArray<Record<string, unknown>>;
  skills?: ReadonlyArray<Record<string, unknown>>;
  deleteAssets?: ReadonlyArray<{ kind: string; name: string }>;
  defaultAgentName?: string | null;
}

/**
 * The body of the `assets.sync` a config push makes for this content by a caller who read
 * the instance just before: every asset at the revision it is at, a new one at `null`.
 */
export async function releaseAtCurrentRevisions(
  stores: { configAssets: ConfigAssetStore },
  clientInstanceId: ClientInstanceId,
  release: ReleaseContent
) {
  const revisionOf = async (kind: string, name: string) => {
    const asset = await stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
    return asset?.revision ?? null;
  };
  const items: Array<Record<string, unknown>> = [];
  for (const [kind, configs] of [
    ["agent", release.agents ?? []],
    ["skill", release.skills ?? []]
  ] as const) {
    for (const config of configs) {
      const expectedRevision = await revisionOf(kind, String(config.name));
      items.push({ type: "put", kind, config, expectedRevision });
    }
  }
  for (const { kind, name } of release.deleteAssets ?? []) {
    items.push({
      type: "delete",
      kind,
      name,
      expectedRevision: (await revisionOf(kind, name)) ?? 1
    });
  }
  return {
    items,
    ...(release.defaultAgentName === undefined
      ? {}
      : { defaultAgentName: release.defaultAgentName })
  };
}

type StoreMutations = Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0];

/**
 * A write to the store as a caller makes it who read every asset just before: each asset the
 * batch writes is named at the revision it is at, a deleted one included, and a name that was
 * never stored at `null`. A test that names bases itself is taken at its word.
 */
export async function applyAtCurrentRevisions(
  store: Pick<ConfigAssetStore, "applyConfigAssetMutations" | "getConfigAsset">,
  input: Omit<StoreMutations, "baseRevisions"> & { baseRevisions?: Record<string, number | null> }
): Promise<{ version: number }> {
  return store.applyConfigAssetMutations({
    ...input,
    baseRevisions: await currentBaseRevisions(store, input)
  });
}

/** The bases `applyAtCurrentRevisions` writes with. */
async function currentBaseRevisions(
  store: Pick<ConfigAssetStore, "getConfigAsset">,
  input: Pick<StoreMutations, "clientInstanceId" | "mutations"> & {
    baseRevisions?: Record<string, number | null>;
  }
): Promise<Record<string, number | null>> {
  if (input.baseRevisions !== undefined) return input.baseRevisions;
  const baseRevisions: Record<string, number | null> = {};
  for (const mutation of input.mutations) {
    if (mutation.type === "setDefaultAgent") continue;
    const key = `${mutation.kind}:${mutation.name}`;
    const asset = await store.getConfigAsset({
      clientInstanceId: input.clientInstanceId,
      kind: mutation.kind,
      name: mutation.name
    });
    baseRevisions[key] = asset?.revision ?? null;
  }
  return baseRevisions;
}
