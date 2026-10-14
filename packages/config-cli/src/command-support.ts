import { credentialOrigin, readStoredCredential } from "./credentials";
import { readConfigCliEnv, type ConfigCliEnv } from "./env";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  agentConfigSchema,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "@vivd-catalyst/asset-schemas";
import { BODY_TOO_LARGE_REASON, UNKNOWN_OPERATION_REASON } from "@vivd-catalyst/api-contract";
import { ConfigApiError, createConfigApi, type ConfigApi } from "./api";
import {
  canonicalizeSkillConfig,
  serializeAgentYaml,
  serializeSkillMarkdown,
  type AssetProvenance
} from "./serialization";
import {
  MANIFEST_FILENAME,
  STATE_FILENAME,
  WorkingCopyValidationError,
  readManifest,
  readStateFile,
  readWorkingCopy,
  writeStateFile,
  type DeletedAssetBaseline,
  type InstanceBaseline,
  type ManifestInstance,
  type ResolvedInstance,
  type WorkingCopyBundle
} from "./working-copy";

export interface ConfigCommandOptions {
  cwd: string;
  dir?: string;
  instance?: string;
  force?: boolean;
  prune?: boolean;
  only?: string[];
  /** The workspace `pull` binds the working copy to, or finds it bound to. */
  workspace?: string;
  assetKind?: "agent" | "skill";
  assetName?: string;
  fetchImpl?: typeof fetch;
  /** Waits between tries of a call. Tests pass one that does not wait. */
  sleep?: (milliseconds: number) => Promise<void>;
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
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

type AssetKindName = "agent" | "skill";

/** The kinds a working copy holds. Kinds read from the instance come with a later release. */
const ASSET_KINDS: readonly AssetKindName[] = ["agent", "skill"];

/** How many assets are read from the instance side by side in one pull. */
const PULL_CONCURRENCY = 8;

type AssetDefinition =
  { kind: "agent"; config: AgentConfig } | { kind: "skill"; config: SkillConfig };

/** One asset as the instance lists it: its place and its revision, without its content. */
export interface RemoteAsset {
  key: string;
  kind: AssetKindName;
  name: string;
  /** The id of the asset: what its revisions count. */
  id: string;
  revision: number;
  /** The listing marks the instance's default agent. */
  isDefault?: true;
}

type FetchedAsset = RemoteAsset & AssetDefinition;

type LocalAsset = { key: string; name: string; contents: string } & AssetDefinition;

/**
 * The instance's config version and default agent. Only a reader of every agent and skill may
 * read them, so a working copy of one Namespace or of one workspace reads neither and knows
 * only its assets.
 */
export async function readInstanceOverview(
  api: ConfigApi,
  instance: ResolvedInstance
): Promise<{ version?: number; defaultAgentName?: string }> {
  return holdsWholeInstance(instance) ? api.getOverview() : {};
}

/** What a batch of the working copy names as its place: its Namespace or its workspace. */
export function batchScope(instance: ManifestInstance): {
  namespace?: string;
  workspaceId?: string;
} {
  return {
    ...(instance.namespace === undefined ? {} : { namespace: instance.namespace }),
    ...(instance.workspace === undefined ? {} : { workspaceId: instance.workspace })
  };
}

/** A working copy of the instance's own assets as a whole: bound to no Namespace or workspace. */
export function holdsWholeInstance(instance: ManifestInstance): boolean {
  return instance.namespace === undefined && instance.workspace === undefined;
}

/**
 * The assets of the instance a working copy holds. A skill that ships with the platform is
 * none of them: a release of the platform writes it, so no pull brings it, no diff shows it and
 * no prune deletes it.
 */
export async function listRemoteAssets(api: ConfigApi): Promise<Map<string, RemoteAsset>> {
  const assets = new Map<string, RemoteAsset>();
  for (const kind of ASSET_KINDS) {
    for (const asset of await api.listAssets(kind)) {
      if (asset.attributes?.origin === "release") continue;
      const key = `${kind}:${asset.name}`;
      assets.set(key, {
        key,
        kind,
        name: asset.name,
        id: asset.id,
        revision: asset.revision,
        ...(asset.isDefault ? { isDefault: true as const } : {})
      });
    }
  }
  return assets;
}

export async function fetchRemoteAsset(
  api: ConfigApi,
  kind: AssetKindName,
  name: string
): Promise<FetchedAsset | undefined> {
  const asset = await api.getAsset(kind, name);
  return (
    asset &&
    readDefinition(
      { key: `${kind}:${name}`, kind, name, id: asset.id, revision: asset.revision },
      asset.config
    )
  );
}

/** A definition read with the schema of its kind, at the place and revision it was found. */
export function readDefinition(remote: RemoteAsset, config: unknown): FetchedAsset {
  const place = { key: remote.key, name: remote.name, id: remote.id, revision: remote.revision };
  return remote.kind === "agent"
    ? { ...place, kind: "agent", config: agentConfigSchema.parse(config) }
    : { ...place, kind: "skill", config: skillConfigSchema.parse(config) };
}

export function bundleOf(assets: readonly AssetDefinition[]): WorkingCopyBundle {
  return {
    agents: assets.flatMap((asset) => (asset.kind === "agent" ? [asset.config] : [])),
    skills: assets.flatMap((asset) => (asset.kind === "skill" ? [asset.config] : []))
  };
}

export function byKey<Entry extends { key: string }>(entry: Entry): [string, Entry] {
  return [entry.key, entry];
}

/** The local assets by key, or none where a local file cannot be read as its kind. */
export async function readLocalAssetsIfValid(
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
export async function mapConcurrently<Item, Result>(
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

export function parseOnlySelectors(values: string[] | undefined): ConfigAssetSelector[] {
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

export function selectBundle(
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

export function assetEntries(bundle: WorkingCopyBundle): LocalAsset[] {
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
export function assetContents(asset: AssetDefinition): string {
  return asset.kind === "agent"
    ? serializeAgentYaml(asset.config)
    : // Match the root serializer/parser, which trims surrounding Markdown whitespace.
      JSON.stringify({
        ...canonicalizeSkillConfig(asset.config),
        content: asset.config.content.trim()
      });
}

export async function replaceSkillPackage(
  skillFilePath: string,
  skill: SkillConfig,
  provenance: AssetProvenance
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
  provenance: AssetProvenance
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

function commandEnv(options: ConfigCommandOptions): ConfigCliEnv {
  return readConfigCliEnv(options.env);
}

/**
 * A client of the instance, signed in with `CATALYST_API_KEY` where it is set and otherwise
 * with the key `catalyst login` saved for the instance's origin.
 */
/**
 * Signs in to the instance. A working copy's commands pass its instance, so a root bound to a
 * workspace reads and writes what that workspace owns.
 */
export async function connectApi(
  url: string,
  options: ConfigCommandOptions,
  bound: Pick<ResolvedInstance, "workspace"> = {}
) {
  const apiKey =
    commandEnv(options).CATALYST_API_KEY ||
    (await readStoredCredential(commandEnv(options), url))?.apiKey;
  if (!apiKey) {
    throw new Error(
      `Not logged in to ${credentialOrigin(url)}. Run 'catalyst login --instance ${url}', or set CATALYST_API_KEY to a key provisioned for automation.`
    );
  }
  return createConfigApi({
    baseUrl: url,
    apiKey,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(bound.workspace === undefined ? {} : { workspaceId: bound.workspace })
  });
}

export function assetHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function recordBaseline(
  workingDir: string,
  instanceKey: string,
  version: number,
  bundle: WorkingCopyBundle,
  /** The asset each written or pulled definition is, and the revision it is at. */
  revisions: Record<string, { id: string; revision: number }> | undefined,
  fullPull: boolean,
  defaultAgentName?: string | null,
  /** The assets that are deleted on the instance, each with the revision of its delete. */
  tombstones: Record<string, DeletedAssetBaseline | undefined> = {}
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
      const written = revisions[asset.key];
      if (written !== undefined) {
        baseline.assets[asset.key] = { ...written, hash: assetHash(asset.contents) };
      }
    }
    const deleted: Record<string, DeletedAssetBaseline> = fullPull ? {} : { ...previous?.deleted };
    for (const key of Object.keys(baseline.assets)) {
      delete deleted[key];
    }
    for (const [key, revision] of Object.entries(tombstones)) {
      delete baseline.assets[key];
      if (revision !== undefined) deleted[key] = revision;
    }
    if (Object.keys(deleted).length > 0) {
      baseline.deleted = deleted;
    } else {
      delete baseline.deleted;
    }
  } else if (fullPull) {
    delete baseline.assets;
  }
  if (defaultAgentName !== undefined) {
    baseline.defaultAgentName = defaultAgentName;
  }
  await writeStateFile(path, { instances: { ...state.instances, [instanceKey]: baseline } });
}

export function resolveWorkingDir(options: ConfigCommandOptions): string {
  return resolve(options.cwd, options.dir ?? ".");
}

function setUnique(files: Map<string, string>, path: string, contents: string): void {
  if (files.has(path)) {
    throw new Error(`Duplicate local config asset path: ${path}`);
  }
  files.set(path, contents);
}

export function byName(left: AgentConfig | SkillConfig, right: AgentConfig | SkillConfig): number {
  return left.name.localeCompare(right.name);
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function formatCommandError(error: unknown): string {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function writeOutput(options: ConfigCommandOptions, text: string): void {
  (options.stdout ?? ((value) => process.stdout.write(value)))(`${text}\n`);
}

export function writeError(options: ConfigCommandOptions, text: string): void {
  (options.stderr ?? ((value) => process.stderr.write(value)))(`${text}\n`);
}
