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
