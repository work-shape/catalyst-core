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
  current: Map<string, { status: "active" | "deleted"; revision: ConfigAssetRevisionRecord }>
): void {
  if (input.baseRevisions === undefined) {
    if (input.baseVersion !== undefined && input.baseVersion !== state.version) {
      throw new AppError("CONFLICT", "Config version mismatch", {
        currentVersion: state.version,
        baseVersion: input.baseVersion
      });
    }
    return;
  }
  const conflicts = [];
  const checkedKeys = new Set<string>();
  let defaultAgentConflict: { currentAgentName: string | null } | undefined;
  for (const mutation of input.mutations) {
    if (mutation.type === "setDefaultAgent") {
      if (input.baseDefaultAgentName === undefined) {
        throw new AppError("VALIDATION_FAILED", "Missing default-agent baseline");
      }
      if (input.baseDefaultAgentName !== (state.defaultAgentName ?? null)) {
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
      throw new AppError("VALIDATION_FAILED", `Missing base revision for '${key}'`);
    }
    const asset = current.get(key);
    const matches =
      base === null
        ? asset === undefined || asset.status === "deleted"
        : asset?.revision.revision === base;
    if (!matches) {
      conflicts.push({
        kind: mutation.kind,
        name: mutation.name,
        currentRevision: asset?.revision.revision ?? null,
        actorLabel: asset?.revision.actor?.displayLabel ?? null,
        timestamp: asset?.revision.createdAt ?? null,
        operation: asset?.revision.operation ?? null
      });
    }
  }
  if (conflicts.length || defaultAgentConflict) {
    throw new AppError("CONFLICT", "Config assets changed since the last pull", {
      conflicts,
      ...(defaultAgentConflict ? { defaultAgentConflict } : {})
    });
  }
}
