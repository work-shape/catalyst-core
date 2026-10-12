import { AppError } from "./errors";
import type {
  ConfigAssetRevisionRecord,
  ConfigAssetState,
  ConfigAssetStore
} from "./config-assets";

type MutationInput = Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0];

/** Check the complete batch before writing. Stores call this under their mutation lock. */
export function assertConfigAssetBases(
  input: MutationInput,
  state: ConfigAssetState,
  current: Map<
    string,
    { id: string; status: "active" | "deleted"; revision: ConfigAssetRevisionRecord }
  >
): void {
  const conflicts = [];
  const replaced: { kind: string; name: string }[] = [];
  const checkedKeys = new Set<string>();
  let defaultAgentConflict: { currentAgentName: string | null } | undefined;
  for (const mutation of input.mutations) {
    if (mutation.type === "setDefaultAgent") {
      // The default is no asset and has no revision. A caller that read it says so and is
      // compared; one that sets it outright, as `assets.set_default` does, names none.
      if (
        input.baseDefaultAgentName !== undefined &&
        input.baseDefaultAgentName !== (state.defaultAgentName ?? null)
      ) {
        defaultAgentConflict = { currentAgentName: state.defaultAgentName ?? null };
      }
      continue;
    }
    const key = `${mutation.kind}:${mutation.name}`;
    if (checkedKeys.has(key)) {
      continue;
    }
    checkedKeys.add(key);
    const base = input.baseRevisions[key];
    if (base === undefined) {
      throw new AppError("PRECONDITION_REQUIRED", `Missing base revision for '${key}'`, {
        reason: "precondition_required",
        assets: [{ kind: mutation.kind, name: mutation.name }]
      });
    }
    const asset = current.get(key);
    const baseId = input.baseAssetIds?.[key];
    if (baseId !== undefined && asset !== undefined && asset.id !== baseId) {
      // Another asset under the name. Its number says nothing of what the writer read.
      replaced.push({ kind: mutation.kind, name: mutation.name });
      continue;
    }
    // A tombstone is a revision like any other: a put that creates the name again names it.
    const matches =
      base === null
        ? asset === undefined || (mutation.type === "delete" && asset.status === "deleted")
        : asset?.revision.revision === base;
    if (!matches) {
      conflicts.push({
        kind: mutation.kind,
        name: mutation.name,
        currentRevision: asset?.revision.revision ?? null,
        deleted: asset?.status === "deleted",
        actorLabel: asset?.revision.actor?.displayLabel ?? null,
        timestamp: asset?.revision.createdAt ?? null,
        operation: asset?.revision.operation ?? null
      });
    }
  }
  if (replaced.length > 0) {
    throw new AppError(
      "CONFLICT",
      "Config assets were replaced by other assets of the same name since they were read",
      { reason: "asset_replaced", assets: replaced }
    );
  }
  if (conflicts.length || defaultAgentConflict) {
    // A stale asset answers the revision conflict; a stale default alone is a plain conflict.
    const code = conflicts.length > 0 ? "REVISION_CONFLICT" : "CONFLICT";
    throw new AppError(code, "Config assets changed since they were read", {
      conflicts,
      ...(defaultAgentConflict ? { defaultAgentConflict } : {})
    });
  }
}
