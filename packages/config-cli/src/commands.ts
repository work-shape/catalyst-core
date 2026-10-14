import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ConfigApiError } from "./api";
import { createUnifiedDiff } from "./diff";
import { serializeAgentYaml, serializeSkillPackageForDisplay } from "./serialization";
import {
  MANIFEST_FILENAME,
  STATE_FILENAME,
  agentAssetPath,
  matchesManifestPath,
  readManifest,
  readStateFile,
  readWorkingCopy,
  removeStaleManifestAssets,
  bindManifestWorkspace,
  resolveInstance,
  skillAssetPath,
  updateManifestDefaultAgent
} from "./working-copy";
import {
  type ConfigCommandOptions,
  assetEntries,
  assetHash,
  bundleOf,
  byKey,
  byName,
  canonicalBundleFiles,
  batchScope,
  connectApi,
  holdsWholeInstance,
  fetchRemoteAsset,
  formatCommandError,
  formatCount,
  listRemoteAssets,
  mapConcurrently,
  parseOnlySelectors,
  readDefinition,
  readInstanceOverview,
  readLocalAssetsIfValid,
  recordBaseline,
  replaceSkillPackage,
  resolveWorkingDir,
  writeError,
  writeOutput
} from "./command-support";
import {
  checkSyncOnThisRelease,
  formatRefusal,
  pushConfig,
  readRefusedBatch,
  readTombstones
} from "./push";

export {
  canonicalBundleFiles,
  resolveSkillResourceTarget,
  type ConfigCommandOptions
} from "./command-support";
export { pushConfig } from "./push";

export type ConfigCommandName = "pull" | "push" | "diff" | "validate" | "list" | "show";

export async function runConfigCommand(
  command: ConfigCommandName,
  options: ConfigCommandOptions
): Promise<number> {
  try {
    switch (command) {
      case "pull":
        return await pullConfig(options);
      case "push":
        return await pushConfig(options);
      case "diff":
        return await diffConfig(options);
      case "validate":
        return await validateConfig(options);
      case "list":
        return await listConfig(options);
      case "show":
        return await showConfig(options);
    }
  } catch (error) {
    writeError(options, formatCommandError(error));
    return 1;
  }
}

export async function pullConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const { manifest, instance } = await bindWorkspace(workingDir, options);
  const api = await connectApi(instance.url, options, instance);
  const overview = await readInstanceOverview(api, instance);
  const listing = await listRemoteAssets(api);
  const selectors = parseOnlySelectors(options.only);
  const wanted =
    selectors.length === 0
      ? [...listing.values()]
      : selectors.flatMap((selector) => listing.get(selector.key) ?? []);
  const baseline = (await readStateFile(resolve(workingDir, STATE_FILENAME))).instances[
    instance.key
  ];
  const local = await readLocalAssetsIfValid(workingDir, manifest);
  // An asset that is at the revision of the last pull, with a local file that still holds
  // what was pulled, is not read again: the file is what the instance holds.
  const pulled = await mapConcurrently(wanted, async (remote) => {
    const base = baseline?.assets?.[remote.key];
    const mine = local.get(remote.key);
    if (
      base &&
      mine &&
      // The same asset, not only the same number: after a database was replaced another
      // asset of the name can be at the revision the last pull recorded.
      base.id === remote.id &&
      base.revision === remote.revision &&
      assetHash(mine.contents) === base.hash
    ) {
      return readDefinition(remote, mine.config);
    }
    // Deleted since it was listed: it is not on the instance.
    return fetchRemoteAsset(api, remote.kind, remote.name);
  });
  const present = pulled.flatMap((asset) => (asset ? [asset] : []));
  const selected = bundleOf(present);
  const revisions = Object.fromEntries(
    present.map((asset) => [asset.key, { id: asset.id, revision: asset.revision }])
  );
  const selectedKeys = new Set(present.map((asset) => asset.key));
  const absentSelectors = selectors.filter((selector) => !selectedKeys.has(selector.key));
  const agents = selected.agents.sort(byName);
  const skills = selected.skills.sort(byName);
  const provenance = {
    instance: instance.key,
    ...(overview.version === undefined ? {} : { version: overview.version })
  };
  const agentTargets = agents.map((agent) => ({
    agent,
    path: agentAssetPath(workingDir, agent.name)
  }));
  const skillTargets = skills.map((skill) => ({
    skill,
    path: skillAssetPath(workingDir, skill.name)
  }));
  assertPullTargetsMatchManifest(workingDir, manifest, agentTargets, skillTargets);
  const desiredPaths = new Set([
    ...agentTargets.map((target) => target.path),
    ...skillTargets.map((target) => target.path)
  ]);

  for (const { agent, path } of agentTargets) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeAgentYaml(agent, provenance), "utf8");
  }
  for (const { skill, path } of skillTargets) {
    await replaceSkillPackage(path, skill, provenance);
  }
  for (const selector of absentSelectors) {
    const path =
      selector.kind === "agent"
        ? agentAssetPath(workingDir, selector.name)
        : skillAssetPath(workingDir, selector.name);
    if (
      !matchesManifestPath(
        workingDir,
        path,
        selector.kind === "agent" ? manifest.agents : manifest.skills
      )
    ) {
      throw new Error(`Selected asset path is not matched by catalyst.yaml: ${selector.key}`);
    }
    await rm(selector.kind === "agent" ? path : dirname(path), {
      recursive: selector.kind === "skill",
      force: true
    });
  }
  // A working copy of one Namespace or one workspace never names the instance's default agent.
  const fullInstancePull = selectors.length === 0 && holdsWholeInstance(instance);
  if (selectors.length === 0) {
    await removeStaleManifestAssets(workingDir, manifest, desiredPaths);
  }
  if (fullInstancePull) {
    await updateManifestDefaultAgent(
      resolve(workingDir, MANIFEST_FILENAME),
      overview.defaultAgentName
    );
  }
  // A name the last pull knew, or this one asked for, that the instance no longer lists was
  // deleted there. The revision of that delete is what a later push names to create it again.
  const goneKeys =
    selectors.length === 0
      ? Object.keys(baseline?.assets ?? {}).filter((key) => !listing.has(key))
      : absentSelectors.map((selector) => selector.key);
  await recordBaseline(
    workingDir,
    instance.key,
    overview.version ?? 0,
    selected,
    revisions,
    selectors.length === 0,
    fullInstancePull ? (overview.defaultAgentName ?? null) : undefined,
    await readTombstones(api, goneKeys)
  );
  writeOutput(
    options,
    `Pulled ${formatCount(agents.length, "agent")}, ${formatCount(skills.length, "skill")}${overview.version === undefined ? "" : `, version ${overview.version}`}.${selectors.length === 0 ? "" : " Scoped pull; selected asset baselines updated."}`
  );
  return 0;
}

/**
 * The manifest and the instance a pull reads, with the root bound to the workspace `--workspace`
 * names where it is not yet. A root is bound once and stays: one bound elsewhere, one of a
 * Namespace and one that holds the instance's own assets already are refused, so a pull
 * never mixes the assets of two owners in one working copy.
 */
async function bindWorkspace(workingDir: string, options: ConfigCommandOptions) {
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const wanted = options.workspace;
  if (wanted === undefined || instance.workspace === wanted) return { manifest, instance };
  if (instance.workspace !== undefined) {
    throw new Error(
      `This working copy is bound to workspace '${instance.workspace}'. Pull another workspace into a directory of its own.`
    );
  }
  if (instance.namespace !== undefined) {
    throw new Error(
      `This working copy belongs to Namespace '${instance.namespace}'. Pull a workspace into a directory of its own.`
    );
  }
  const baseline = (await readStateFile(resolve(workingDir, STATE_FILENAME))).instances[
    instance.key
  ];
  if (baseline !== undefined) {
    throw new Error(
      `This working copy holds the instance's own assets of '${instance.key}'. Pull a workspace into a directory of its own.`
    );
  }
  if (manifest.instances[instance.key] === undefined) {
    throw new Error(
      `Name the instance in ${MANIFEST_FILENAME} to bind it to a workspace: '${instance.key}' is not one of its instances.`
    );
  }
  await bindManifestWorkspace(resolve(workingDir, MANIFEST_FILENAME), instance.key, wanted);
  const bound = await readManifest(workingDir);
  const boundInstance = resolveInstance(bound, options.instance);
  if (boundInstance.workspace !== wanted) {
    throw new Error(
      `Could not bind instance '${instance.key}' in ${MANIFEST_FILENAME}: add 'workspace: ${wanted}' to that instance yourself, beside its url.`
    );
  }
  writeOutput(options, `Bound this working copy to workspace '${wanted}'.`);
  return { manifest: bound, instance: boundInstance };
}

function assertPullTargetsMatchManifest(
  workingDir: string,
  manifest: Awaited<ReturnType<typeof readManifest>>,
  agentTargets: Array<{ path: string }>,
  skillTargets: Array<{ path: string }>
): void {
  const unmatched = [
    ...agentTargets.filter(
      (target) => !matchesManifestPath(workingDir, target.path, manifest.agents)
    ),
    ...skillTargets.filter(
      (target) => !matchesManifestPath(workingDir, target.path, manifest.skills)
    )
  ];
  if (unmatched.length > 0) {
    throw new Error(
      "Pulled assets use the canonical layout (agents/*.agent.yaml and skills/*/SKILL.md), but one or more target paths are not matched by catalyst.yaml. Use the canonical layout or adjust the manifest globs before pulling."
    );
  }
}

export async function diffConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const local = await readWorkingCopy(workingDir, manifest);
  const api = await connectApi(instance.url, options, instance);
  const overview = await readInstanceOverview(api, instance);
  const remoteAssets = await listRemoteAssets(api);
  const baseline = (await readStateFile(resolve(workingDir, STATE_FILENAME))).instances[
    instance.key
  ];
  if (baseline?.assets === undefined) {
    writeOutput(
      options,
      "No per-asset baseline is available. Run 'catalyst config pull' first; local and remote changes cannot yet be distinguished."
    );
    return 1;
  }
  const localAssets = new Map(assetEntries(local).map(byKey));
  const keys = [
    ...new Set([...localAssets.keys(), ...remoteAssets.keys(), ...Object.keys(baseline.assets)])
  ].sort();
  const output: string[] = [];
  for (const key of keys) {
    const localAsset = localAssets.get(key);
    const remoteAsset = remoteAssets.get(key);
    const base = baseline.assets[key];
    const localChanged = localAsset
      ? assetHash(localAsset.contents) !== base?.hash
      : base !== undefined;
    const remoteChanged =
      (remoteAsset?.revision ?? null) !== (base?.revision ?? null) ||
      // Another asset under the name, whatever its number.
      (remoteAsset !== undefined && base !== undefined && remoteAsset.id !== base.id);
    if (!localChanged && !remoteChanged) {
      continue;
    }
    output.push(
      `${key}: ${localChanged && remoteChanged ? "conflict" : remoteChanged ? "remote newer" : "changed locally"}`
    );
    if (localChanged && !remoteChanged) {
      // The content of the instance's asset is read for the assets changed locally and for
      // no other: the list answers revisions, which is all the rest of the comparison needs.
      const fetched = remoteAsset
        ? await fetchRemoteAsset(api, remoteAsset.kind, remoteAsset.name)
        : undefined;
      const localFiles = canonicalBundleFiles(bundleOf(localAsset ? [localAsset] : []));
      const remoteFiles = canonicalBundleFiles(bundleOf(fetched ? [fetched] : []));
      for (const path of [...new Set([...localFiles.keys(), ...remoteFiles.keys()])].sort()) {
        const diff = createUnifiedDiff(
          { path, contents: remoteFiles.get(path) },
          { path, contents: localFiles.get(path) }
        );
        if (diff) {
          output.push(diff.trimEnd());
        }
      }
    }
  }
  if (baseline.defaultAgentName !== undefined) {
    const localChanged = (local.defaultAgentName ?? null) !== baseline.defaultAgentName;
    const remoteChanged = (overview.defaultAgentName ?? null) !== baseline.defaultAgentName;
    if (localChanged || remoteChanged) {
      output.push(
        `default agent: ${localChanged && remoteChanged ? "conflict" : remoteChanged ? "remote newer" : "changed locally"}`
      );
    }
  }
  writeOutput(options, output.length ? output.join("\n") : "No differences.");
  return output.length ? 1 : 0;
}

export async function validateConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const bundle = await readWorkingCopy(workingDir, manifest);
  const api = await connectApi(instance.url, options, instance);
  const listing = await listRemoteAssets(api);
  const deleted = (await readStateFile(resolve(workingDir, STATE_FILENAME))).instances[instance.key]
    ?.deleted;
  try {
    // The whole working copy, each asset against the revision the instance holds now: the
    // check says whether a push of everything would be accepted, whatever was pulled last.
    // An asset the instance does not list is a creation, made against the delete this
    // working copy saw of it where there was one.
    await checkSyncOnThisRelease(api, {
      ...batchScope(instance),
      items: assetEntries(bundle).map((asset) => ({
        type: "put" as const,
        kind: asset.kind,
        config: { ...asset.config },
        expectedRevision: listing.get(asset.key)?.revision ?? deleted?.[asset.key]?.revision ?? null
      })),
      ...(bundle.defaultAgentName === undefined
        ? {}
        : { defaultAgentName: bundle.defaultAgentName })
    });
    writeOutput(
      options,
      `Valid: ${formatCount(bundle.agents.length, "agent")}, ${formatCount(bundle.skills.length, "skill")}.`
    );
    return 0;
  } catch (error) {
    const refusal = error instanceof ConfigApiError ? readRefusedBatch(error) : undefined;
    if (!refusal) {
      throw error;
    }
    writeError(options, formatRefusal("Validation failed", refusal));
    return 1;
  }
}

export async function listConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const local = await readWorkingCopy(workingDir, manifest);
  const api = await connectApi(instance.url, options, instance);
  const version = String((await readInstanceOverview(api, instance)).version ?? "-");
  const remote = await listRemoteAssets(api);
  const localKeys = new Set(assetEntries(local).map((asset) => asset.key));
  const rows = [
    ...[...remote.values()].map((asset) => ({
      ...asset,
      version,
      status: localKeys.has(asset.key) ? "-" : "missing locally"
    })),
    ...assetEntries(local)
      .filter((asset) => !remote.has(asset.key))
      .map((asset) => ({ ...asset, version: "-", status: "missing remotely" }))
  ].sort((left, right) => left.key.localeCompare(right.key));
  writeOutput(
    options,
    [
      "KIND\tNAME\tREMOTE VERSION\tSTATUS",
      ...rows.map((row) => `${row.kind}\t${row.name}\t${row.version}\t${row.status}`)
    ].join("\n")
  );
  return 0;
}

export async function showConfig(options: ConfigCommandOptions): Promise<number> {
  if (!options.assetKind || !options.assetName) {
    throw new Error("Usage: catalyst config show <agent|skill> <name>");
  }
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const api = await connectApi(instance.url, options, instance);
  const remote = await fetchRemoteAsset(api, options.assetKind, options.assetName);
  if (!remote) {
    throw new Error(`Remote ${options.assetKind} '${options.assetName}' was not found.`);
  }
  writeOutput(
    options,
    (remote.kind === "agent"
      ? serializeAgentYaml(remote.config)
      : serializeSkillPackageForDisplay(remote.config)
    ).trimEnd()
  );
  return 0;
}
