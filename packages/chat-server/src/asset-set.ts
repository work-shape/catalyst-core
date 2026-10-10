import { AppError, type AssetValidationIssue, type ConfigAssetRecord } from "@vivd-catalyst/core";
import { findDefaultAgentReferenceIssues, findDuplicates } from "@vivd-catalyst/config-schema";
import {
  configValuesEqual,
  readDefinitionName,
  type ConfigAssetBundle,
  type WorkflowAssetKind
} from "./asset-kinds/shared";

/**
 * The active definitions of an instance, held by kind id. It is what every write is checked
 * as: the set the write would leave. Any registered kind has a place in it.
 */
export interface AssetSet {
  defaultAgentName?: string;
  definitions: ReadonlyMap<string, readonly unknown[]>;
}

export function definitionsOf(set: AssetSet, kind: string): readonly unknown[] {
  return set.definitions.get(kind) ?? [];
}

export function findDefinition(set: AssetSet, kind: string, name: string): unknown {
  return definitionsOf(set, kind).find((candidate) => readDefinitionName(candidate) === name);
}

export function assetSetOf(
  assets: readonly ConfigAssetRecord[],
  defaultAgentName: string | undefined
): AssetSet {
  const definitions = new Map<string, unknown[]>();
  for (const asset of assets) {
    if (asset.config === null) continue;
    const ofKind = definitions.get(asset.kind) ?? [];
    ofKind.push(asset.config);
    definitions.set(asset.kind, ofKind);
  }
  return { ...(defaultAgentName === undefined ? {} : { defaultAgentName }), definitions };
}

function withDefinitions(set: AssetSet, kind: string, definitions: readonly unknown[]): AssetSet {
  return { ...set, definitions: new Map([...set.definitions, [kind, definitions]]) };
}

/** The set with one definition added, or put in the place of the one that carries its name. */
export function withDefinition(
  set: AssetSet,
  kind: string,
  name: string,
  definition: unknown
): AssetSet {
  return withDefinitions(set, kind, [
    ...definitionsOf(set, kind).filter((candidate) => readDefinitionName(candidate) !== name),
    definition
  ]);
}

export function withoutDefinition(set: AssetSet, kind: string, name: string): AssetSet {
  return withDefinitions(
    set,
    kind,
    definitionsOf(set, kind).filter((candidate) => readDefinitionName(candidate) !== name)
  );
}

export function withDefaultAgentName(
  set: AssetSet,
  defaultAgentName: string | undefined
): AssetSet {
  const { defaultAgentName: _replaced, ...rest } = set;
  return defaultAgentName === undefined ? rest : { ...rest, defaultAgentName };
}

/** What a release bundle carries, as a set. A kind without a bundle slot is left as `base` has it. */
export function assetSetOfBundle(
  kinds: readonly WorkflowAssetKind[],
  bundle: ConfigAssetBundle,
  base?: AssetSet
): AssetSet {
  const definitions = new Map<string, readonly unknown[]>(base?.definitions ?? []);
  for (const kind of kinds) {
    if (kind.bundle) definitions.set(kind.kind, kind.bundle.definitions(bundle));
  }
  return {
    ...(bundle.defaultAgentName === undefined ? {} : { defaultAgentName: bundle.defaultAgentName }),
    definitions
  };
}

/** One issue of a set, with the asset it belongs to where it is one asset's. */
export interface AssetSetIssue {
  message: string;
  assetKind?: string;
  assetName?: string;
  index?: number;
  path?: PropertyKey[];
}

export const INVALID_ASSET_SET_MESSAGE = "Config asset bundle is invalid";

/**
 * What a set would have to change before it can be written, read from the registered kinds
 * and from nothing else. The order is fixed: every kind's schema and name issues in
 * registration order, then doubled names, then the instance default, then each kind's own
 * reference checks.
 */
export function findAssetSetIssues(
  kinds: readonly WorkflowAssetKind[],
  set: AssetSet
): {
  issues: AssetSetIssue[];
  accepted: AssetSet;
  validateWrite(stored: AssetSet): AssetSetIssue[];
} {
  const issues: AssetSetIssue[] = [];
  const readings = kinds.map((kind) => ({
    kind,
    reading: kind.read(definitionsOf(set, kind.kind))
  }));
  for (const { kind, reading } of readings) {
    for (const refused of reading.refused) {
      for (const issue of refused.issues) {
        issues.push({
          message: issue.message,
          assetKind: kind.kind,
          ...(refused.name === undefined ? {} : { assetName: refused.name }),
          index: refused.index,
          path: issue.path ?? []
        });
      }
    }
  }
  const accepted: AssetSet = {
    ...(set.defaultAgentName === undefined ? {} : { defaultAgentName: set.defaultAgentName }),
    definitions: new Map(readings.map(({ kind, reading }) => [kind.kind, reading.accepted]))
  };
  const names = (kind: string) =>
    definitionsOf(accepted, kind).flatMap((definition) => readDefinitionName(definition) ?? []);
  for (const { kind } of readings) {
    for (const duplicate of findDuplicates(names(kind.kind))) {
      issues.push({ message: `Duplicate ${kind.kind} definitions: ${duplicate}` });
    }
  }
  for (const { kind } of readings) {
    if (!kind.holdsInstanceDefault) continue;
    issues.push(
      ...findDefaultAgentReferenceIssues({
        agentNames: names(kind.kind),
        defaultAgentName: set.defaultAgentName
      }).map((message) => ({ message }))
    );
  }
  const acceptedByName = definitionsByName(accepted);
  const context = (stored?: AssetSet) => {
    const storedByName = stored === undefined ? undefined : definitionsByName(stored);
    return {
      definitions: (kind: string) => definitionsOf(accepted, kind),
      changes: (kind: string, name: string) =>
        storedByName === undefined ||
        !configValuesEqual(storedByName(kind).get(name), acceptedByName(kind).get(name))
    };
  };
  for (const { reading } of readings) {
    issues.push(...reading.validate(context()).map(plainIssue));
  }
  return {
    issues,
    accepted,
    validateWrite: (stored) =>
      readings.flatMap(({ reading }) => reading.validateWrite(context(stored)).map(plainIssue))
  };
}

/** Looks definitions up by name, reading each kind once and only when it is asked for. */
function definitionsByName(set: AssetSet): (kind: string) => Map<string, unknown> {
  const byKind = new Map<string, Map<string, unknown>>();
  return (kind) => {
    let byName = byKind.get(kind);
    if (!byName) {
      byName = new Map();
      for (const definition of definitionsOf(set, kind)) {
        const name = readDefinitionName(definition);
        if (name !== undefined) byName.set(name, definition);
      }
      byKind.set(kind, byName);
    }
    return byName;
  };
}

function plainIssue(issue: AssetValidationIssue): AssetSetIssue {
  return { message: issue.message, ...(issue.path === undefined ? {} : { path: issue.path }) };
}

/**
 * Checks the set a write would leave and returns it as the kinds read it, defaults applied.
 * `stored` is the set as it is stored now: a rule that tolerates what is stored already does
 * not refuse a definition the write leaves as it is. Without it every definition counts as
 * changed.
 */
export function validateAssetSet(
  kinds: readonly WorkflowAssetKind[],
  set: AssetSet,
  stored?: AssetSet
): AssetSet {
  const found = findAssetSetIssues(kinds, set);
  if (found.issues.length > 0) {
    throw new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, { issues: found.issues });
  }
  const writeIssues = found.validateWrite(stored ?? { definitions: new Map() });
  if (writeIssues.length > 0) {
    throw new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, { issues: writeIssues });
  }
  return found.accepted;
}
