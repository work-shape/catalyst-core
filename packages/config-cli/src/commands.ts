import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  agentConfigSchema,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "@vivd-catalyst/config-schema";
import { ConfigApiError, createConfigApi } from "./api";
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
  const exported = await api.exportAssets();
  const remote = parseExportBundle(exported);
  const selectors = parseOnlySelectors(options.only);
  const selected = selectBundle(remote, selectors, false);
  const selectedKeys = new Set(assetEntries(selected).map((asset) => asset.key));
  const absentSelectors = selectors.filter((selector) => !selectedKeys.has(selector.key));
  const agents = selected.agents.sort(byName);
  const skills = selected.skills.sort(byName);
  const provenance = { instance: instance.key, version: exported.version };
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
      exported.defaultAgentName
    );
  }
  await recordBaseline(
    workingDir,
    instance.key,
    exported.version,
    selected,
    exported.revisions,
    selectors.length === 0,
    selectors.length === 0 ? (exported.defaultAgentName ?? null) : undefined,
    absentSelectors.map((selector) => selector.key)
  );
  writeOutput(
    options,
    `Pulled ${formatCount(agents.length, "agent")}, ${formatCount(skills.length, "skill")}, version ${exported.version}.${selectors.length === 0 ? "" : " Scoped pull; selected asset baselines updated."}`
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
  const exported = await api.exportAssets();
  if (exported.perAssetConcurrency !== true || exported.revisions === undefined) {
    throw new Error(
      "This server does not support per-asset config conflicts. Upgrade the server before pushing with this CLI."
    );
  }
  const remote = parseExportBundle(exported);
  const touchedKeys = new Set(
    assetEntries(bundle)
      .filter(
        (asset) =>
          options.force || baseline?.assets?.[asset.key]?.hash !== assetHash(asset.contents)
      )
      .map((asset) => asset.key)
  );
  const touched: WorkingCopyBundle = {
    agents: bundle.agents.filter((asset) => touchedKeys.has(`agent:${asset.name}`)),
    skills: bundle.skills.filter((asset) => touchedKeys.has(`skill:${asset.name}`))
  };
  const localKeys = new Set(assetEntries(local).map((asset) => asset.key));
  const deleteAssets = options.prune
    ? assetEntries(remote)
        .filter((asset) => !localKeys.has(asset.key))
        .map(({ kind, name }) => ({ kind, name }))
    : [];
  const changesDefault =
    selectors.length === 0 &&
    (options.force || (bundle.defaultAgentName ?? null) !== baseline?.defaultAgentName);
  if (changesDefault && !options.force && baseline?.defaultAgentName === undefined) {
    throw new Error(
      "No default-agent baseline is recorded. Run 'catalyst config pull' before changing the default agent."
    );
  }
  writeOutput(
    options,
    formatPushPlan(
      createPushPlan(bundle, selectBundle(remote, selectors, false), touchedKeys),
      options.prune === true
    )
  );
  if (!touchedKeys.size && !deleteAssets.length && !changesDefault) {
    writeOutput(options, "No local changes to push.");
    return 0;
  }
  const baseRevisions = Object.fromEntries(
    [...touchedKeys, ...deleteAssets.map((asset) => `${asset.kind}:${asset.name}`)].map((key) => [
      key,
      baseline?.assets?.[key]?.revision ?? null
    ])
  );
  try {
    const result = await api.replaceAssets({
      ...touched,
      ...(changesDefault && bundle.defaultAgentName !== undefined
        ? { defaultAgentName: bundle.defaultAgentName }
        : {}),
      baseVersion: null,
      ...(!options.force ? { baseRevisions } : {}),
      ...(changesDefault ? { baseDefaultAgentName: baseline?.defaultAgentName ?? null } : {}),
      deleteAssets,
      mode: "merge"
    });
    // Refresh only applied assets whose exported content still matches the local files.
    // A concurrent change stays guarded by the revision this push applied.
    const updated = await api.exportAssets();
    const applied = parseExportBundle(updated);
    const appliedContents = new Map(
      assetEntries(applied).map((asset) => [asset.key, asset.contents])
    );
    const revisions: Record<string, number> = {};
    for (const asset of assetEntries(touched)) {
      const revision = updated.revisions?.[asset.key];
      if (revision !== undefined && appliedContents.get(asset.key) === asset.contents) {
        revisions[asset.key] = revision;
      } else if (!options.force && baseRevisions[asset.key] !== null) {
        revisions[asset.key] = (baseRevisions[asset.key] ?? 0) + 1;
      }
    }
    await recordBaseline(
      workingDir,
      instance.key,
      result.version,
      touched,
      revisions,
      false,
      changesDefault ? (bundle.defaultAgentName ?? null) : undefined,
      deleteAssets.map((asset) => `${asset.kind}:${asset.name}`)
    );
    writeOutput(
      options,
      `Pushed ${formatCount(touched.agents.length, "agent")}, ${formatCount(touched.skills.length, "skill")}, version ${result.version}.`
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
    if (error instanceof ConfigApiError && error.status === 409) {
      writeError(options, formatPushConflict(error, options));
      return 1;
    }
    if (isValidationApiError(error)) {
      writeError(options, formatValidationFailure(error));
      return 1;
    }
    throw error;
  }
}

export async function diffConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const local = await readWorkingCopy(workingDir, manifest);
  const api = await connectApi(instance.url, options);
  const remoteExport = await api.exportAssets();
  const remote = parseExportBundle(remoteExport);
  const baseline = (await readStateFile(resolve(workingDir, STATE_FILENAME))).instances[
    instance.key
  ];
  if (baseline?.assets === undefined || remoteExport.revisions === undefined) {
    writeOutput(
      options,
      "No per-asset baseline is available. Run 'catalyst config pull' first; local and remote changes cannot yet be distinguished."
    );
    return 1;
  }
  const localAssets = new Map(assetEntries(local).map((asset) => [asset.key, asset]));
  const remoteAssets = new Map(assetEntries(remote).map((asset) => [asset.key, asset]));
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
    const remoteChanged = (remoteExport.revisions[key] ?? null) !== (base?.revision ?? null);
    if (!localChanged && !remoteChanged) {
      continue;
    }
    output.push(
      `${key}: ${localChanged && remoteChanged ? "conflict" : remoteChanged ? "remote newer" : "changed locally"}`
    );
    if (localChanged && !remoteChanged) {
      const localFiles = canonicalBundleFiles({
        agents:
          localAsset?.kind === "agent"
            ? local.agents.filter((asset) => asset.name === localAsset.name)
            : [],
        skills:
          localAsset?.kind === "skill"
            ? local.skills.filter((asset) => asset.name === localAsset.name)
            : []
      });
      const remoteFiles = canonicalBundleFiles({
        agents:
          remoteAsset?.kind === "agent"
            ? remote.agents.filter((asset) => asset.name === remoteAsset.name)
            : [],
        skills:
          remoteAsset?.kind === "skill"
            ? remote.skills.filter((asset) => asset.name === remoteAsset.name)
            : []
      });
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
    const remoteChanged = (remote.defaultAgentName ?? null) !== baseline.defaultAgentName;
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
  try {
    await api.validateAssets(bundle);
    writeOutput(
      options,
      `Valid: ${formatCount(bundle.agents.length, "agent")}, ${formatCount(bundle.skills.length, "skill")}.`
    );
    return 0;
  } catch (error) {
    if (isValidationApiError(error)) {
      writeError(options, formatValidationFailure(error));
      return 1;
    }
    throw error;
  }
}

export async function listConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const local = await readWorkingCopy(workingDir, manifest);
  const api = await connectApi(instance.url, options);
  const exported = await api.exportAssets();
  const remote = parseExportBundle(exported);
  const localKeys = new Set(assetEntries(local).map((asset) => asset.key));
  const remoteKeys = new Set(assetEntries(remote).map((asset) => asset.key));
  const rows = [
    ...assetEntries(remote).map((asset) => ({
      ...asset,
      version: String(exported.version),
      status: localKeys.has(asset.key) ? "-" : "missing locally"
    })),
    ...assetEntries(local)
      .filter((asset) => !remoteKeys.has(asset.key))
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
  const remote = parseExportBundle(await api.exportAssets());
  const config = (options.assetKind === "agent" ? remote.agents : remote.skills).find(
    (asset) => asset.name === options.assetName
  );
  if (!config) {
    throw new Error(`Remote ${options.assetKind} '${options.assetName}' was not found.`);
  }
  writeOutput(
    options,
    (options.assetKind === "agent"
      ? serializeAgentYaml(config)
      : serializeSkillPackageForDisplay(config)
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

function parseExportBundle(exported: {
  defaultAgentName?: string;
  agents: unknown[];
  skills: unknown[];
}): WorkingCopyBundle {
  return {
    ...(exported.defaultAgentName === undefined
      ? {}
      : { defaultAgentName: exported.defaultAgentName }),
    agents: exported.agents.map((agent) => agentConfigSchema.parse(agent)),
    skills: exported.skills.map((skill) => skillConfigSchema.parse(skill))
  };
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

function assetEntries(bundle: WorkingCopyBundle): Array<{
  key: string;
  kind: "agent" | "skill";
  name: string;
  contents: string;
}> {
  return [
    ...bundle.agents.map((agent) => ({
      key: `agent:${agent.name}`,
      kind: "agent" as const,
      name: agent.name,
      contents: serializeAgentYaml(agent)
    })),
    ...bundle.skills.map((skill) => ({
      key: `skill:${skill.name}`,
      kind: "skill" as const,
      name: skill.name,
      // Match the root serializer/parser, which trims surrounding Markdown whitespace.
      contents: JSON.stringify({ ...canonicalizeSkillConfig(skill), content: skill.content.trim() })
    }))
  ];
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

function createPushPlan(
  local: WorkingCopyBundle,
  remote: WorkingCopyBundle,
  touchedKeys: Set<string>
): PushPlan {
  const localAssets = new Map(assetEntries(local).map((asset) => [asset.key, asset]));
  const remoteAssets = new Map(assetEntries(remote).map((asset) => [asset.key, asset]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [key, asset] of localAssets) {
    const remoteAsset = remoteAssets.get(key);
    if (!touchedKeys.has(key)) {
      unchanged += 1;
    } else if (!remoteAsset) {
      added += 1;
    } else if (remoteAsset.contents === asset.contents) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }
  return {
    added,
    updated,
    unchanged,
    remoteOnly: [...remoteAssets.keys()].filter((key) => !localAssets.has(key)).sort()
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
  return options.env ?? process.env;
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
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
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

function formatPushConflict(error: ConfigApiError, options: ConfigCommandOptions): string {
  const details = isRecord(error.details) ? error.details : {};
  const conflicts = Array.isArray(details.conflicts) ? details.conflicts.filter(isRecord) : [];
  const selectors = conflicts.map((asset) => `${String(asset.kind)}:${String(asset.name)}`);
  const argumentsList = [
    "catalyst config pull",
    ...(options.dir ? ["--dir", shellQuote(options.dir)] : []),
    ...(options.instance ? ["--instance", shellQuote(options.instance)] : []),
    ...selectors.flatMap((selector) => ["--only", shellQuote(selector)])
  ];
  if (details.defaultAgentConflict) {
    // A full pull refreshes the manifest's default-agent pointer as well as assets.
    argumentsList.splice(
      argumentsList.indexOf("--only") === -1
        ? argumentsList.length
        : argumentsList.indexOf("--only")
    );
  }
  return [
    "Push conflict; nothing was applied.",
    ...conflicts.map(
      (asset) =>
        `- ${String(asset.kind)}:${String(asset.name)}: revision ${String(asset.currentRevision ?? "absent")}, ${String(asset.operation ?? "unknown operation")} by ${String(asset.actorLabel ?? "unknown actor")} at ${String(asset.timestamp ?? "unknown time")}`
    ),
    ...(details.defaultAgentConflict
      ? ["- default agent changed on the instance; a full pull is required."]
      : []),
    details.defaultAgentConflict
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

function isValidationApiError(error: unknown): error is ConfigApiError {
  return (
    error instanceof ConfigApiError && (error.status === 422 || error.code === "VALIDATION_FAILED")
  );
}

function formatValidationFailure(error: ConfigApiError): string {
  const issues = readValidationIssues(error.details);
  return issues.length === 0
    ? `Validation failed: ${error.message}`
    : `Validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
}

function readValidationIssues(details: unknown): string[] {
  if (!isRecord(details) || !Array.isArray(details.issues)) {
    return [];
  }
  return details.issues.flatMap((issue) => {
    if (!isRecord(issue) || typeof issue.message !== "string") {
      return [];
    }
    const asset =
      typeof issue.assetKind === "string"
        ? `${issue.assetKind}${typeof issue.assetName === "string" ? ` '${issue.assetName}'` : typeof issue.index === "number" ? ` #${issue.index + 1}` : ""}`
        : "config";
    const path =
      Array.isArray(issue.path) && issue.path.length > 0
        ? ` (${issue.path.map(String).join(".")})`
        : "";
    return [`${asset}${path}: ${issue.message}`];
  });
}

function formatCommandError(error: unknown): string {
  if (error instanceof WorkingCopyValidationError) {
    return `Local validation failed:\n${error.issues
      .map((issue) => `- ${issue.file}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`)
      .join("\n")}`;
  }
  if (error instanceof ConfigApiError) {
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
