import { readConfigCliEnv } from "./env";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  agentConfigSchema,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "@vivd-catalyst/config-schema";
import {
  ASSET_RELEASE_SYNC_MAX_ITEMS,
  BODY_TOO_LARGE_REASON,
  UNKNOWN_OPERATION_REASON
} from "@vivd-catalyst/api-contract";
import { ConfigApiError, createConfigApi, type ConfigApi, type SyncBatch } from "./api";
import { createUnifiedDiff } from "./diff";
import { API_KEY_ENV_NAME, createLocalApiKey, writeApiKeyToEnvFile } from "./local-key";
import {
  canonicalizeSkillConfig,
  serializeAgentYaml,
  serializeSkillMarkdown,
  serializeSkillPackageForDisplay
} from "./serialization";
import {
  MANIFEST_FILENAME,
  STATE_FILENAME,
  WorkingCopyValidationError,
  agentAssetPath,
  matchesManifestPath,
  readManifest,
  readStateFile,
  readWorkingCopy,
  removeStaleManifestAssets,
  resolveInstance,
  skillAssetPath,
  updateManifestDefaultAgent,
  writeStateFile,
  type InstanceBaseline,
  type WorkingCopyBundle
} from "./working-copy";

export type ConfigCommandName =
  "pull" | "push" | "diff" | "validate" | "list" | "show" | "local-key";

export interface ConfigCommandOptions {
  cwd: string;
  dir?: string;
  instance?: string;
  force?: boolean;
  prune?: boolean;
  only?: string[];
  assetKind?: "agent" | "skill";
  assetName?: string;
  /** `local-key`: the client instance config. Default: `config/app.yaml` in the working copy. */
  appConfig?: string;
  /** `local-key`: the env file that receives the key. Default: `.env` in the working copy. */
  envFile?: string;
  /** `local-key`: the variable written. Default: the one the CLI reads. */
  envName?: string;
  fetchImpl?: typeof fetch;
  /** Waits between tries of a call. Tests pass one that does not wait. */
  sleep?: (milliseconds: number) => Promise<void>;
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

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
      case "local-key":
        return await localKey(options);
    }
  } catch (error) {
    writeError(options, formatCommandError(error));
    return 1;
  }
}

async function localKey(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const instance = resolveInstance(await readManifest(workingDir), options.instance);
  const apiKey = await createLocalApiKey({
    baseUrl: instance.url,
    configPath: options.appConfig
      ? resolve(options.cwd, options.appConfig)
      : resolve(workingDir, "config/app.yaml"),
    env: commandEnv(options),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });
  const envName = options.envName ?? API_KEY_ENV_NAME;
  const file = await writeApiKeyToEnvFile(
    options.envFile ? resolve(options.cwd, options.envFile) : resolve(workingDir, ".env"),
    envName,
    apiKey
  );
  writeOutput(options, `Created a key for ${instance.url} and wrote ${envName} to ${file}.`);
  return 0;
}

export async function pullConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const api = await connectApi(instance.url, options);
  const overview = await api.getOverview();
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
  const revisions = Object.fromEntries(present.map((asset) => [asset.key, asset.revision]));
  const selectedKeys = new Set(present.map((asset) => asset.key));
  const absentSelectors = selectors.filter((selector) => !selectedKeys.has(selector.key));
  const agents = selected.agents.sort(byName);
  const skills = selected.skills.sort(byName);
  const provenance = { instance: instance.key, version: overview.version };
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
  if (selectors.length === 0) {
    await removeStaleManifestAssets(workingDir, manifest, desiredPaths);
    await updateManifestDefaultAgent(
      resolve(workingDir, MANIFEST_FILENAME),
      overview.defaultAgentName
    );
  }
  await recordBaseline(
    workingDir,
    instance.key,
    overview.version,
    selected,
    revisions,
    selectors.length === 0,
    selectors.length === 0 ? (overview.defaultAgentName ?? null) : undefined,
    absentSelectors.map((selector) => selector.key)
  );
  writeOutput(
    options,
    `Pulled ${formatCount(agents.length, "agent")}, ${formatCount(skills.length, "skill")}, version ${overview.version}.${selectors.length === 0 ? "" : " Scoped pull; selected asset baselines updated."}`
  );
  return 0;
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

export async function pushConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const local = await readWorkingCopy(workingDir, manifest);
  const selectors = parseOnlySelectors(options.only);
  if (options.prune && selectors.length > 0) {
    throw new Error("--prune cannot be combined with --only.");
  }
  const bundle = selectBundle(local, selectors, true);
  const state = await readStateFile(resolve(workingDir, STATE_FILENAME));
  const baseline = state.instances[instance.key];
  if (!options.force && baseline?.assets === undefined) {
    throw new Error(
      `No per-asset baseline is recorded for '${instance.key}'. Run 'catalyst config pull' first or use 'catalyst config push --force'.`
    );
  }
  const api = await connectApi(instance.url, options);
  const listing = await listRemoteAssets(api);
  const touched = assetEntries(bundle).filter(
    (asset) => options.force || baseline?.assets?.[asset.key]?.hash !== assetHash(asset.contents)
  );
  const touchedKeys = new Set(touched.map((asset) => asset.key));
  const localKeys = new Set(assetEntries(local).map((asset) => asset.key));
  const deleteAssets = options.prune
    ? [...listing.values()].filter((asset) => !localKeys.has(asset.key))
    : [];
  const changesDefault =
    selectors.length === 0 &&
    (options.force || (bundle.defaultAgentName ?? null) !== baseline?.defaultAgentName);
  if (changesDefault && !options.force && baseline?.defaultAgentName === undefined) {
    throw new Error(
      "No default-agent baseline is recorded. Run 'catalyst config pull' before changing the default agent."
    );
  }
  /**
   * The revision an item is made against. A push names the revision of the last pull, so a
   * change on the instance since then refuses it. With --force it names the revision the
   * instance holds now: the local file wins over whatever is there, and only a write that
   * arrives between this read and the push still refuses it.
   */
  const baseRevision = (key: string): number | undefined =>
    options.force ? listing.get(key)?.revision : baseline?.assets?.[key]?.revision;
  const selectedRemote = selectors.length
    ? new Map(selectors.flatMap((selector) => listing.get(selector.key) ?? []).map(byKey))
    : listing;
  writeOutput(
    options,
    formatPushPlan(
      await createPushPlan(api, bundle, selectedRemote, touchedKeys, baseline),
      options.prune === true
    )
  );
  if (!touched.length && !deleteAssets.length && !changesDefault) {
    writeOutput(options, "No local changes to push.");
    return 0;
  }
  // An asset to delete that no pull of this working copy has seen was created since. The
  // instance is asked for nothing: a delete names the revision it was decided on.
  const unseen = deleteAssets.filter((asset) => baseRevision(asset.key) === undefined);
  if (unseen.length > 0) {
    writeError(
      options,
      await formatPushConflict(
        api,
        unseen.map((asset) => ({ ...asset, currentRevision: asset.revision })),
        false,
        options
      )
    );
    return 1;
  }
  const items: SyncBatch["items"] = [
    ...touched.map((asset) => {
      const expectedRevision = baseRevision(asset.key);
      return {
        type: "put" as const,
        kind: asset.kind,
        config: { ...asset.config },
        ...(expectedRevision === undefined ? {} : { expectedRevision })
      };
    }),
    ...deleteAssets.map((asset) => ({
      type: "delete" as const,
      kind: asset.kind,
      name: asset.name,
      expectedRevision: baseRevision(asset.key) ?? asset.revision
    }))
  ];
  if (items.length > ASSET_RELEASE_SYNC_MAX_ITEMS) {
    throw new Error(
      `This push changes ${items.length} assets, and one push holds at most ${ASSET_RELEASE_SYNC_MAX_ITEMS}. Push in parts with --only.`
    );
  }
  try {
    const outcome = await api.syncAssets({
      items,
      ...(changesDefault
        ? {
            defaultAgentName: bundle.defaultAgentName ?? null,
            ...(options.force
              ? {}
              : { expectedDefaultAgentName: baseline?.defaultAgentName ?? null })
          }
        : {})
    });
    if (outcome.status === "pending_approval") {
      writeError(
        options,
        `The push waits for an approval on the instance and nothing was applied yet (Operation Run ${outcome.operationRunId}). When it is approved, run 'catalyst config pull' to record the new revisions.`
      );
      return 1;
    }
    const result = outcome.output;
    const revisions = Object.fromEntries(
      result.items.flatMap((item) =>
        item.status === "applied" && item.type === "put"
          ? [[`${item.kind}:${item.name}`, item.revision]]
          : []
      )
    );
    const pushed = bundleOf(touched);
    await recordBaseline(
      workingDir,
      instance.key,
      result.version,
      pushed,
      revisions,
      false,
      changesDefault ? (bundle.defaultAgentName ?? null) : undefined,
      deleteAssets.map((asset) => asset.key)
    );
    writeOutput(
      options,
      `Pushed ${formatCount(pushed.agents.length, "agent")}, ${formatCount(pushed.skills.length, "skill")}, version ${result.version}.`
    );
    if (result.hiddenAgentNames?.length) {
      writeOutput(
        options,
        [
          "Hidden in every workspace until an instance admin sets their availability:",
          ...result.hiddenAgentNames.map((name) => `  agent:${name}`)
        ].join("\n")
      );
    }
    return 0;
  } catch (error) {
    const refusal = error instanceof ConfigApiError ? readRefusedBatch(error) : undefined;
    if (!refusal) {
      throw error;
    }
    if (refusal.conflicts.length > 0 || refusal.defaultAgentConflict) {
      writeError(
        options,
        await formatPushConflict(api, refusal.conflicts, refusal.defaultAgentConflict, options)
      );
      return 1;
    }
    writeError(
      options,
      formatRefusal(
        refusal.validation ? "Validation failed" : "Push refused; nothing was applied",
        refusal
      )
    );
    return 1;
  }
}

export async function diffConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const local = await readWorkingCopy(workingDir, manifest);
  const api = await connectApi(instance.url, options);
  const overview = await api.getOverview();
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
    const remoteChanged = (remoteAsset?.revision ?? null) !== (base?.revision ?? null);
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
  const api = await connectApi(instance.url, options);
  const listing = await listRemoteAssets(api);
  try {
    // The whole working copy, each asset against the revision the instance holds now: the
    // check says whether a push of everything would be accepted, whatever was pulled last.
    await api.checkSync({
      items: assetEntries(bundle).map((asset) => {
        const revision = listing.get(asset.key)?.revision;
        return {
          type: "put" as const,
          kind: asset.kind,
          config: { ...asset.config },
          ...(revision === undefined ? {} : { expectedRevision: revision })
        };
      }),
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
  const api = await connectApi(instance.url, options);
  const overview = await api.getOverview();
  const remote = await listRemoteAssets(api);
  const localKeys = new Set(assetEntries(local).map((asset) => asset.key));
  const rows = [
    ...[...remote.values()].map((asset) => ({
      ...asset,
      version: String(overview.version),
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
  const api = await connectApi(instance.url, options);
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

export function canonicalBundleFiles(bundle: WorkingCopyBundle): Map<string, string> {
  const files = new Map<string, string>();
  files.set(
    MANIFEST_FILENAME,
    bundle.defaultAgentName === undefined
      ? ""
      : `defaultAgentName: ${JSON.stringify(bundle.defaultAgentName)}\n`
  );
  for (const agent of [...bundle.agents].sort(byName)) {
    setUnique(files, `agents/${agent.name}.agent.yaml`, serializeAgentYaml(agent));
  }
  for (const skill of [...bundle.skills].sort(byName)) {
    setUnique(files, `skills/${skill.name}/SKILL.md`, serializeSkillMarkdown(skill));
    for (const resource of skill.resources ?? []) {
      setUnique(files, `skills/${skill.name}/${resource.path}`, resource.content);
    }
  }
  return files;
}

interface ConfigAssetSelector {
  kind: "agent" | "skill";
  name: string;
  key: string;
}

interface PushPlan {
  added: number;
  updated: number;
  unchanged: number;
  remoteOnly: string[];
}

type AssetKindName = "agent" | "skill";

/** The kinds a working copy holds. Kinds read from the instance come with a later release. */
const ASSET_KINDS: readonly AssetKindName[] = ["agent", "skill"];

/** How many assets are read from the instance side by side in one pull. */
const PULL_CONCURRENCY = 8;

type AssetDefinition =
  { kind: "agent"; config: AgentConfig } | { kind: "skill"; config: SkillConfig };

/** One asset as the instance lists it: its place and its revision, without its content. */
interface RemoteAsset {
  key: string;
  kind: AssetKindName;
  name: string;
  revision: number;
}

type FetchedAsset = RemoteAsset & AssetDefinition;
type LocalAsset = { key: string; name: string; contents: string } & AssetDefinition;

async function listRemoteAssets(api: ConfigApi): Promise<Map<string, RemoteAsset>> {
  const assets = new Map<string, RemoteAsset>();
  for (const kind of ASSET_KINDS) {
    for (const asset of await api.listAssets(kind)) {
      const key = `${kind}:${asset.name}`;
      assets.set(key, { key, kind, name: asset.name, revision: asset.revision });
    }
  }
  return assets;
}

async function fetchRemoteAsset(
  api: ConfigApi,
  kind: AssetKindName,
  name: string
): Promise<FetchedAsset | undefined> {
  const asset = await api.getAsset(kind, name);
  return (
    asset &&
    readDefinition({ key: `${kind}:${name}`, kind, name, revision: asset.revision }, asset.config)
  );
}

/** A definition read with the schema of its kind, at the place and revision it was found. */
function readDefinition(remote: RemoteAsset, config: unknown): FetchedAsset {
  const place = { key: remote.key, name: remote.name, revision: remote.revision };
  return remote.kind === "agent"
    ? { ...place, kind: "agent", config: agentConfigSchema.parse(config) }
    : { ...place, kind: "skill", config: skillConfigSchema.parse(config) };
}

function bundleOf(assets: readonly AssetDefinition[]): WorkingCopyBundle {
  return {
    agents: assets.flatMap((asset) => (asset.kind === "agent" ? [asset.config] : [])),
    skills: assets.flatMap((asset) => (asset.kind === "skill" ? [asset.config] : []))
  };
}

function byKey<Entry extends { key: string }>(entry: Entry): [string, Entry] {
  return [entry.key, entry];
}

/** The local assets by key, or none where a local file cannot be read as its kind. */
async function readLocalAssetsIfValid(
  workingDir: string,
  manifest: Awaited<ReturnType<typeof readManifest>>
): Promise<Map<string, LocalAsset>> {
  try {
    return new Map(assetEntries(await readWorkingCopy(workingDir, manifest)).map(byKey));
  } catch (error) {
    if (error instanceof WorkingCopyValidationError) {
      return new Map();
    }
    throw error;
  }
}

/** Runs `work` for every item, a few at a time, and answers in the order of the items. */
async function mapConcurrently<Item, Result>(
  items: readonly Item[],
  work: (item: Item) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await work(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PULL_CONCURRENCY, items.length) }, worker));
  return results;
}

function parseOnlySelectors(values: string[] | undefined): ConfigAssetSelector[] {
  const selectors = new Map<string, ConfigAssetSelector>();
  for (const value of values ?? []) {
    const match = /^(agent|skill):(.+)$/u.exec(value);
    if (!match) {
      throw new Error(`Invalid --only value '${value}'. Use agent:<name> or skill:<name>.`);
    }
    const kind = match[1] as ConfigAssetSelector["kind"];
    const name = match[2]!;
    const key = `${kind}:${name}`;
    selectors.set(key, { kind, name, key });
  }
  return [...selectors.values()];
}

function selectBundle(
  bundle: WorkingCopyBundle,
  selectors: ConfigAssetSelector[],
  requireMatches: boolean
): WorkingCopyBundle {
  if (selectors.length === 0) {
    return bundle;
  }
  const selectedAgents = new Set(
    selectors.filter((selector) => selector.kind === "agent").map((selector) => selector.name)
  );
  const selectedSkills = new Set(
    selectors.filter((selector) => selector.kind === "skill").map((selector) => selector.name)
  );
  const agents = bundle.agents.filter((agent) => selectedAgents.has(agent.name));
  const skills = bundle.skills.filter((skill) => selectedSkills.has(skill.name));
  if (requireMatches) {
    const matched = new Set([
      ...agents.map((agent) => `agent:${agent.name}`),
      ...skills.map((skill) => `skill:${skill.name}`)
    ]);
    const missing = selectors.filter((selector) => !matched.has(selector.key));
    if (missing.length > 0) {
      throw new Error(
        `Selected config ${missing.length === 1 ? "asset does" : "assets do"} not exist: ${missing.map((selector) => selector.key).join(", ")}.`
      );
    }
  }
  return { agents, skills };
}

function assetEntries(bundle: WorkingCopyBundle): LocalAsset[] {
  return [
    ...bundle.agents.map((agent) => ({
      key: `agent:${agent.name}`,
      kind: "agent" as const,
      name: agent.name,
      contents: assetContents({ kind: "agent", config: agent }),
      config: agent
    })),
    ...bundle.skills.map((skill) => ({
      key: `skill:${skill.name}`,
      kind: "skill" as const,
      name: skill.name,
      contents: assetContents({ kind: "skill", config: skill }),
      config: skill
    }))
  ];
}

/** What an asset is compared and hashed as, whatever the formatting of its files. */
function assetContents(asset: AssetDefinition): string {
  return asset.kind === "agent"
    ? serializeAgentYaml(asset.config)
    : // Match the root serializer/parser, which trims surrounding Markdown whitespace.
      JSON.stringify({
        ...canonicalizeSkillConfig(asset.config),
        content: asset.config.content.trim()
      });
}

async function replaceSkillPackage(
  skillFilePath: string,
  skill: SkillConfig,
  provenance: { instance: string; version: number }
): Promise<void> {
  const targetDirectory = dirname(skillFilePath);
  const parentDirectory = dirname(targetDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    resolve(parentDirectory, `.${basename(targetDirectory)}.pull-`)
  );
  const backupDirectory = `${temporaryDirectory}.previous`;
  let previousMoved = false;

  try {
    await writeSkillPackage(temporaryDirectory, skill, provenance);
    try {
      await rename(targetDirectory, backupDirectory);
      previousMoved = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await rename(temporaryDirectory, targetDirectory);
    } catch (error) {
      if (previousMoved) {
        try {
          await rename(backupDirectory, targetDirectory);
          previousMoved = false;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Failed to install and restore skill package '${skill.name}'`
          );
        }
      }
      throw error;
    }

    if (previousMoved) {
      await rm(backupDirectory, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeSkillPackage(
  directory: string,
  skill: SkillConfig,
  provenance: { instance: string; version: number }
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "SKILL.md"),
    serializeSkillMarkdown(skill, provenance),
    "utf8"
  );
  for (const resource of skill.resources ?? []) {
    const resourcePath = resolveSkillResourceTarget(directory, resource.path);
    await mkdir(dirname(resourcePath), { recursive: true });
    await writeFile(resourcePath, resource.content, "utf8");
  }
}

export function resolveSkillResourceTarget(skillDirectory: string, resourcePath: string): string {
  if (/^[A-Za-z]:/u.test(resourcePath) || /[\u0000-\u001f\u007f]/u.test(resourcePath)) {
    throw new Error(`Skill resource path must stay within its package: ${resourcePath}`);
  }
  const target = resolve(skillDirectory, resourcePath);
  const relativeTarget = relative(skillDirectory, target);
  if (
    relativeTarget === "" ||
    isAbsolute(relativeTarget) ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`)
  ) {
    throw new Error(`Skill resource path must stay within its package: ${resourcePath}`);
  }
  return target;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * What a push would do to each local asset. Whether a touched asset differs from the
 * instance's is read from the baseline where the instance still holds the pulled revision,
 * and from the instance's content only where it does not.
 */
async function createPushPlan(
  api: ConfigApi,
  local: WorkingCopyBundle,
  remote: ReadonlyMap<string, RemoteAsset>,
  touchedKeys: Set<string>,
  baseline: InstanceBaseline | undefined
): Promise<PushPlan> {
  const localAssets = assetEntries(local);
  const differs = await mapConcurrently(localAssets, async (asset) => {
    const remoteAsset = remote.get(asset.key);
    if (!touchedKeys.has(asset.key) || !remoteAsset) {
      return false;
    }
    const base = baseline?.assets?.[asset.key];
    if (base?.revision === remoteAsset.revision) {
      return base.hash !== assetHash(asset.contents);
    }
    const fetched = await fetchRemoteAsset(api, remoteAsset.kind, remoteAsset.name);
    return fetched === undefined || assetContents(fetched) !== asset.contents;
  });
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  localAssets.forEach((asset, index) => {
    if (touchedKeys.has(asset.key) && !remote.has(asset.key)) {
      added += 1;
    } else if (differs[index]) {
      updated += 1;
    } else {
      unchanged += 1;
    }
  });
  const localKeys = new Set(localAssets.map((asset) => asset.key));
  return {
    added,
    updated,
    unchanged,
    remoteOnly: [...remote.keys()].filter((key) => !localKeys.has(key)).sort()
  };
}

function formatPushPlan(plan: PushPlan, prune: boolean): string {
  const lines = [
    `Push plan (${prune ? "mirror" : "merge"}):`,
    `  Added: ${plan.added}`,
    `  Updated: ${plan.updated}`,
    `  Unchanged: ${plan.unchanged}`
  ];
  if (prune) {
    lines.push(`  Deleted: ${plan.remoteOnly.length}`);
    if (plan.remoteOnly.length > 0) {
      lines.push("Assets to delete:", ...plan.remoteOnly.map((key) => `- ${key}`));
    }
  } else if (plan.remoteOnly.length > 0) {
    lines.push(
      "Warning: these assets exist only on the instance and will be kept:",
      ...plan.remoteOnly.map((key) => `- ${key}`),
      "Use --prune to delete them."
    );
  }
  return lines.join("\n");
}

function commandEnv(options: ConfigCommandOptions) {
  return readConfigCliEnv(options.env);
}

async function connectApi(url: string, options: ConfigCommandOptions) {
  const apiKey = commandEnv(options).CATALYST_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing CLI credentials. Set CATALYST_API_KEY to a key created under Administration, API Access. For a local development instance, 'catalyst config local-key' creates one."
    );
  }
  return createConfigApi({
    baseUrl: url,
    apiKey,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

function assetHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function recordBaseline(
  workingDir: string,
  instanceKey: string,
  version: number,
  bundle: WorkingCopyBundle,
  revisions: Record<string, number> | undefined,
  fullPull: boolean,
  defaultAgentName?: string | null,
  deletedKeys: string[] = []
): Promise<void> {
  const path = resolve(workingDir, STATE_FILENAME);
  const state = await readStateFile(path);
  const previous = state.instances[instanceKey];
  const baseline: InstanceBaseline = {
    ...previous,
    lastPulledVersion: fullPull ? version : (previous?.lastPulledVersion ?? version)
  };
  if (revisions !== undefined) {
    baseline.assets = fullPull ? {} : { ...previous?.assets };
    for (const asset of assetEntries(bundle)) {
      const revision = revisions[asset.key];
      if (revision !== undefined) {
        baseline.assets[asset.key] = { revision, hash: assetHash(asset.contents) };
      }
    }
    for (const key of deletedKeys) {
      delete baseline.assets[key];
    }
  } else if (fullPull) {
    delete baseline.assets;
  }
  if (defaultAgentName !== undefined) {
    baseline.defaultAgentName = defaultAgentName;
  }
  await writeStateFile(path, { instances: { ...state.instances, [instanceKey]: baseline } });
}

interface AssetConflict {
  kind: string;
  name: string;
  /** The revision the instance holds, or null where it holds no such asset. */
  currentRevision: number | null;
}

/** A batch the instance did not apply, as the command reports it. */
interface RefusedBatch {
  message: string;
  /** The answer is about the definitions, not about rights or revisions. */
  validation: boolean;
  conflicts: AssetConflict[];
  defaultAgentConflict: boolean;
  /** One line per refused item and per issue of the set. */
  lines: string[];
}

/** Reads the error of a refused sync or check. Any other error is not one. */
function readRefusedBatch(error: ConfigApiError): RefusedBatch | undefined {
  const details = isRecord(error.details) ? error.details : {};
  const defaultAgentConflict =
    error.code === "CONFLICT" && details.reason === "default_agent_changed";
  if (details.reason !== "sync_refused" && !defaultAgentConflict && error.status !== 422) {
    return undefined;
  }
  const refused = (Array.isArray(details.items) ? details.items : []).flatMap((item) =>
    isRecord(item) && isRecord(item.error) ? [{ item, refusal: item.error }] : []
  );
  const label = (item: Record<string, unknown>) =>
    `${String(item.kind)}${typeof item.name === "string" ? ` '${item.name}'` : typeof item.index === "number" ? ` #${item.index + 1}` : ""}`;
  const issues = (Array.isArray(details.issues) ? details.issues : []).flatMap((issue) =>
    isRecord(issue) && typeof issue.message === "string" ? [issue] : []
  );
  return {
    message: error.message,
    validation: error.status === 422,
    defaultAgentConflict,
    conflicts: refused.flatMap(({ item, refusal }) =>
      refusal.code === "CONFLICT" && typeof item.name === "string"
        ? [
            {
              kind: String(item.kind),
              name: item.name,
              currentRevision:
                typeof refusal.currentRevision === "number" ? refusal.currentRevision : null
            }
          ]
        : []
    ),
    lines: [
      ...refused.map(({ item, refusal }) => `${label(item)}: ${String(refusal.message)}`),
      ...issues.map((issue) => {
        const path =
          Array.isArray(issue.path) && issue.path.length > 0
            ? ` (${issue.path.map(String).join(".")})`
            : "";
        return `config${path}: ${String(issue.message)}`;
      })
    ]
  };
}

function formatRefusal(title: string, refusal: RefusedBatch): string {
  if (refusal.lines.length === 0) {
    // The instance bounds a batch by its caller. Where that refuses a push, parts fit.
    const hint = /^A batch holds at most/u.test(refusal.message)
      ? " Push in parts with --only."
      : "";
    return `${title}: ${refusal.message}${hint}`;
  }
  return `${title}:\n${refusal.lines.map((line) => `- ${line}`).join("\n")}`;
}

async function formatPushConflict(
  api: ConfigApi,
  conflicts: readonly AssetConflict[],
  defaultAgentConflict: boolean,
  options: ConfigCommandOptions
): Promise<string> {
  const selectors = conflicts.map((asset) => `${asset.kind}:${asset.name}`);
  const argumentsList = [
    "catalyst config pull",
    ...(options.dir ? ["--dir", shellQuote(options.dir)] : []),
    ...(options.instance ? ["--instance", shellQuote(options.instance)] : []),
    // A full pull refreshes the manifest's default-agent pointer as well as assets.
    ...(defaultAgentConflict
      ? []
      : selectors.flatMap((selector) => ["--only", shellQuote(selector)]))
  ];
  // Who changed each asset is its latest revision, a delete included. A key that may not
  // read it reports the conflict without the name.
  const latest = await mapConcurrently(conflicts, (asset) =>
    api.getLatestRevision(asset.kind, asset.name).catch(() => undefined)
  );
  return [
    "Push conflict; nothing was applied.",
    ...conflicts.map((asset, index) => {
      const revision = latest[index];
      return `- ${asset.kind}:${asset.name}: revision ${String(revision?.revision ?? asset.currentRevision ?? "absent")}, ${revision?.operation ?? "unknown operation"} by ${revision?.actor?.displayLabel ?? "unknown actor"} at ${revision?.createdAt ?? "unknown time"}`;
    }),
    ...(defaultAgentConflict
      ? ["- default agent changed on the instance; a full pull is required."]
      : []),
    defaultAgentConflict
      ? "Commit or stash local edits in git first: a full pull overwrites the local working copy."
      : "Commit or stash local edits in git first: pull overwrites the local files for these assets.",
    argumentsList.join(" "),
    "Review with 'catalyst config diff', re-apply local edits, and push again. Use --force only for a deliberate overwrite."
  ].join("\n");
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_:./-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function resolveWorkingDir(options: ConfigCommandOptions): string {
  return resolve(options.cwd, options.dir ?? ".");
}

function setUnique(files: Map<string, string>, path: string, contents: string): void {
  if (files.has(path)) {
    throw new Error(`Duplicate local config asset path: ${path}`);
  }
  files.set(path, contents);
}

function byName(left: AgentConfig | SkillConfig, right: AgentConfig | SkillConfig): number {
  return left.name.localeCompare(right.name);
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatCommandError(error: unknown): string {
  if (error instanceof WorkingCopyValidationError) {
    return `Local validation failed:\n${error.issues
      .map((issue) => `- ${issue.file}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`)
      .join("\n")}`;
  }
  if (error instanceof ConfigApiError) {
    const reason = isRecord(error.details) ? error.details.reason : undefined;
    if (reason === BODY_TOO_LARGE_REASON) {
      return "The request is larger than the instance accepts in one call. Push in parts with --only.";
    }
    if (error.status === 404 && reason === UNKNOWN_OPERATION_REASON) {
      return "This instance does not serve the asset operations this CLI uses. Upgrade the instance, or use the CLI of its release.";
    }
    return `${error.code ? `${error.code}: ` : ""}${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeOutput(options: ConfigCommandOptions, text: string): void {
  (options.stdout ?? ((value) => process.stdout.write(value)))(`${text}\n`);
}

function writeError(options: ConfigCommandOptions, text: string): void {
  (options.stderr ?? ((value) => process.stderr.write(value)))(`${text}\n`);
}
