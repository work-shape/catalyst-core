import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  agentConfigSchema,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "@vivd-catalyst/config-schema";
import { ConfigApiError, createConfigApi } from "./api";
import { createUnifiedDiff } from "./diff";
import { serializeAgentYaml, serializeSkillMarkdown } from "./serialization";
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
  type WorkingCopyBundle
} from "./working-copy";

export type ConfigCommandName = "pull" | "push" | "diff" | "validate";

export interface ConfigCommandOptions {
  cwd: string;
  dir?: string;
  instance?: string;
  force?: boolean;
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
    }
  } catch (error) {
    writeError(options, formatCommandError(error));
    return 1;
  }
}

export async function pullConfig(options: ConfigCommandOptions): Promise<number> {
  const workingDir = resolveWorkingDir(options);
  const manifest = await readManifest(workingDir);
  const instance = resolveInstance(manifest, options.instance);
  const api = await connectApi(instance.url, options);
  const exported = await api.exportAssets();
  const agents = exported.agents.map((agent) => agentConfigSchema.parse(agent)).sort(byName);
  const skills = exported.skills.map((skill) => skillConfigSchema.parse(skill)).sort(byName);
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
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeSkillMarkdown(skill, provenance), "utf8");
  }
  await removeStaleManifestAssets(workingDir, manifest, desiredPaths);
  await updateManifestDefaultAgent(
    resolve(workingDir, MANIFEST_FILENAME),
    exported.defaultAgentName
  );
  await updateStateVersion(workingDir, instance.key, exported.version);
  writeOutput(
    options,
    `Pulled ${formatCount(agents.length, "agent")}, ${formatCount(skills.length, "skill")}, version ${exported.version}.`
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
  const bundle = await readWorkingCopy(workingDir, manifest);
  const state = await readStateFile(resolve(workingDir, STATE_FILENAME));
  const lastPulledVersion = state.instances[instance.key]?.lastPulledVersion;
  if (!options.force && lastPulledVersion === undefined) {
    throw new Error(
      `No pulled version is recorded for '${instance.key}'. Run 'catalyst config pull' first or use 'catalyst config push --force'.`
    );
  }
  const api = await connectApi(instance.url, options);
  try {
    const result = await api.replaceAssets({
      ...bundle,
      baseVersion: options.force ? null : lastPulledVersion
    });
    await updateStateVersion(workingDir, instance.key, result.version);
    writeOutput(
      options,
      `Pushed ${formatCount(bundle.agents.length, "agent")}, ${formatCount(bundle.skills.length, "skill")}, version ${result.version}.`
    );
    return 0;
  } catch (error) {
    if (error instanceof ConfigApiError && error.status === 409) {
      const currentVersion = readDetailNumber(error.details, "currentVersion");
      writeError(
        options,
        [
          `Push conflict: remote is at version ${currentVersion ?? "unknown"}; you last pulled ${lastPulledVersion ?? "none"}.`,
          "Run 'catalyst config diff', then 'catalyst config pull', re-apply your changes, and push again.",
          "Use 'catalyst config push --force' only when you intend to overwrite the remote configuration."
        ].join("\n")
      );
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
  const remote: WorkingCopyBundle = {
    ...(remoteExport.defaultAgentName === undefined
      ? {}
      : { defaultAgentName: remoteExport.defaultAgentName }),
    agents: remoteExport.agents.map((agent) => agentConfigSchema.parse(agent)),
    skills: remoteExport.skills.map((skill) => skillConfigSchema.parse(skill))
  };
  const remoteFiles = canonicalBundleFiles(remote);
  const localFiles = canonicalBundleFiles(local);
  const paths = [...new Set([...remoteFiles.keys(), ...localFiles.keys()])].sort();
  const output = paths
    .map((path) =>
      createUnifiedDiff(
        { path, contents: remoteFiles.get(path) },
        { path, contents: localFiles.get(path) }
      )
    )
    .join("");
  if (!output) {
    writeOutput(options, "No differences.");
    return 0;
  }
  writeOutput(options, output.trimEnd());
  return 1;
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
  }
  return files;
}

async function connectApi(url: string, options: ConfigCommandOptions) {
  const env = options.env ?? process.env;
  const apiKey = env.CATALYST_API_KEY;
  const serverCredential = env.CATALYST_SERVER_CREDENTIAL ?? env.CHAT_SERVER_CREDENTIAL;
  if (!apiKey && !serverCredential) {
    throw new Error(
      "Missing CLI credentials. Set CATALYST_API_KEY. For one-release legacy compatibility, CATALYST_SERVER_CREDENTIAL or CHAT_SERVER_CREDENTIAL is also accepted."
    );
  }
  if (!apiKey) {
    writeError(
      options,
      "Deprecation warning: CLI authentication with CATALYST_SERVER_CREDENTIAL or CHAT_SERVER_CREDENTIAL will be removed after one compatibility release. Create a key in API Access and set CATALYST_API_KEY."
    );
  }
  return createConfigApi({
    baseUrl: url,
    ...(apiKey ? { apiKey } : { serverCredential }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });
}

async function updateStateVersion(
  workingDir: string,
  instanceKey: string,
  version: number
): Promise<void> {
  const path = resolve(workingDir, STATE_FILENAME);
  const state = await readStateFile(path);
  await writeStateFile(path, {
    instances: {
      ...state.instances,
      [instanceKey]: { lastPulledVersion: version }
    }
  });
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
    error instanceof ConfigApiError &&
    (error.status === 422 || error.code === "VALIDATION_FAILED")
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
    const path = Array.isArray(issue.path) && issue.path.length > 0
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

function readDetailNumber(details: unknown, key: string): number | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const value = details[key];
  return typeof value === "number" ? value : undefined;
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
