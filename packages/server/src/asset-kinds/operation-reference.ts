import {
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_OPERATION_PREFIX,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_OPERATION_PREFIX
} from "@work-shape/catalyst-core";

/** The kind of asset each operation prefix names one of, by its name after the prefix. */
const OPERATION_ASSET_KINDS: readonly (readonly [prefix: string, kind: string])[] = [
  ["connection.", "connection"],
  ["app.", "app"],
  [DATA_STORE_OPERATION_PREFIX, DATA_STORE_ASSET_KIND],
  [WORKFLOW_OPERATION_PREFIX, WORKFLOW_ASSET_KIND],
  [KNOWLEDGE_OPERATION_PREFIX, KNOWLEDGE_BASE_ASSET_KIND]
];

/**
 * The asset an operation filter names, as `data_store.kunden.insert` names the Data Store
 * `kunden`: nothing for a prefix of every asset of a kind, `data_store.*`, which a workspace
 * guardrail narrows to its workspace by its reach.
 */
export function assetOfOperation(operation: string): { kind: string; name: string } | undefined {
  for (const [prefix, kind] of OPERATION_ASSET_KINDS) {
    if (!operation.startsWith(prefix)) continue;
    const name = operation.slice(prefix.length).split(".")[0];
    return name === undefined || name === "" || name === "*" ? undefined : { kind, name };
  }
  return undefined;
}
