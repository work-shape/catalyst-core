import { z } from "zod";
import type { ClientInstanceId } from "@vivd-catalyst/core";
import type { TestCallInput, TestOperationName } from "./operations";
import type { TestStore } from "./test-instance";

const assetParamsSchema = z.object({ kind: z.string(), name: z.string() });
const payloadSchema = z.record(z.string(), z.unknown());

/**
 * A write of one asset as a caller makes it who read the asset just before: it carries the
 * revision the asset is at. A test that is about the revision check names `expectedRevision`
 * itself and is left as it is. A delete or revert of an asset that does not exist names
 * revision 1, so the call is complete and is answered by what the test is about.
 */
export async function atCurrentRevision(
  stores: Pick<TestStore, "configAssets">,
  clientInstanceId: ClientInstanceId,
  operation: TestOperationName,
  input: TestCallInput
): Promise<TestCallInput> {
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
  const asset = await stores.configAssets.getConfigAsset({ clientInstanceId, ...params.data });
  const revision =
    operation === "assets.put"
      ? asset?.status === "active"
        ? asset.revision
        : undefined
      : (asset?.revision ?? 1);
  return revision === undefined
    ? input
    : { ...input, payload: { ...payload.data, expectedRevision: revision } };
}

interface ReleaseContent {
  agents?: ReadonlyArray<Record<string, unknown>>;
  skills?: ReadonlyArray<Record<string, unknown>>;
  deleteAssets?: ReadonlyArray<{ kind: string; name: string }>;
  defaultAgentName?: string | null;
}

/**
 * The body of the `assets.sync` a config push makes for this content by a caller who read
 * the instance just before: every asset at the revision it is at, a new one without one.
 */
export async function releaseAtCurrentRevisions(
  stores: Pick<TestStore, "configAssets">,
  clientInstanceId: ClientInstanceId,
  release: ReleaseContent
) {
  const revisionOf = async (kind: string, name: string) => {
    const asset = await stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
    return asset?.status === "active" ? asset.revision : undefined;
  };
  const items: Array<Record<string, unknown>> = [];
  for (const [kind, configs] of [
    ["agent", release.agents ?? []],
    ["skill", release.skills ?? []]
  ] as const) {
    for (const config of configs) {
      const expectedRevision = await revisionOf(kind, String(config.name));
      items.push({
        type: "put",
        kind,
        config,
        ...(expectedRevision === undefined ? {} : { expectedRevision })
      });
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
