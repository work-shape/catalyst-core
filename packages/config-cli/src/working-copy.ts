import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";
import {
  agentConfigSchema,
  parseSkillMarkdown,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "@vivd-catalyst/config-schema";

export const MANIFEST_FILENAME = "catalyst.yaml";
export const STATE_FILENAME = ".catalyst-state.json";

export interface CatalystManifest {
  instances: Record<string, { url: string }>;
  defaultInstance?: string;
  defaultAgentName?: string;
  agents: string[];
  skills: string[];
}

export interface ResolvedInstance {
  key: string;
  url: string;
}

export interface CatalystState {
  instances: Record<string, { lastPulledVersion: number }>;
}

export interface WorkingCopyBundle {
  defaultAgentName?: string;
  agents: AgentConfig[];
  skills: SkillConfig[];
}

export interface WorkingCopyIssue {
  file: string;
  message: string;
  path?: string;
}

export class WorkingCopyValidationError extends Error {
  readonly issues: WorkingCopyIssue[];

  constructor(issues: WorkingCopyIssue[]) {
    super("Local config assets are invalid");
    this.name = "WorkingCopyValidationError";
    this.issues = issues;
  }
}

export function parseManifest(contents: string, source = MANIFEST_FILENAME): CatalystManifest {
  const input = yaml.load(contents);
  if (!isRecord(input)) {
    throw new Error(`${source} must contain a YAML object`);
  }
  const instancesInput = input.instances;
  if (!isRecord(instancesInput)) {
    throw new Error(`${source} must define an instances mapping`);
  }
  const instances: Record<string, { url: string }> = {};
  for (const [name, value] of Object.entries(instancesInput)) {
    if (!isRecord(value) || typeof value.url !== "string" || value.url.length === 0) {
      throw new Error(`${source} instance '${name}' must define a url`);
    }
    instances[name] = { url: normalizeUrl(value.url, `${source} instance '${name}'`) };
  }

  const defaultInstance = readOptionalString(input, "defaultInstance", source);
  const defaultAgentName = readOptionalString(input, "defaultAgentName", source);
  return {
    instances,
    ...(defaultInstance === undefined ? {} : { defaultInstance }),
    ...(defaultAgentName === undefined ? {} : { defaultAgentName }),
    agents: readStringArray(input, "agents", source),
    skills: readStringArray(input, "skills", source)
  };
}

export async function readManifest(workingDir: string): Promise<CatalystManifest> {
  const path = resolve(workingDir, MANIFEST_FILENAME);
  return parseManifest(await readFile(path, "utf8"), path);
}

export function resolveInstance(
  manifest: CatalystManifest,
  requestedInstance?: string
): ResolvedInstance {
  const key = requestedInstance ?? manifest.defaultInstance;
  if (!key) {
    throw new Error(`No instance selected; pass --instance or set defaultInstance in ${MANIFEST_FILENAME}`);
  }
  const configured = manifest.instances[key];
  if (configured) {
    return { key, url: configured.url };
  }
  return { key, url: normalizeUrl(key, `Instance '${key}'`) };
}

export async function readStateFile(path: string): Promise<CatalystState> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { instances: {} };
    }
    throw error;
  }
  const input: unknown = JSON.parse(contents);
  if (!isRecord(input) || !isRecord(input.instances)) {
    throw new Error(`${path} must contain an instances object`);
  }
  const instances: CatalystState["instances"] = {};
  for (const [name, value] of Object.entries(input.instances)) {
    if (
      !isRecord(value) ||
      typeof value.lastPulledVersion !== "number" ||
      !Number.isInteger(value.lastPulledVersion) ||
      value.lastPulledVersion < 0
    ) {
      throw new Error(`${path} has an invalid lastPulledVersion for '${name}'`);
    }
    instances[name] = { lastPulledVersion: value.lastPulledVersion };
  }
  return { instances };
}

export async function writeStateFile(path: string, state: CatalystState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function readWorkingCopy(
  workingDir: string,
  manifest: CatalystManifest
): Promise<WorkingCopyBundle> {
  const [agentFiles, skillFiles] = await Promise.all([
    matchManifestFiles(workingDir, manifest.agents),
    matchManifestFiles(workingDir, manifest.skills)
  ]);
  const agents: AgentConfig[] = [];
  const skills: SkillConfig[] = [];
  const issues: WorkingCopyIssue[] = [];

  for (const path of agentFiles) {
    const file = toRelativePath(workingDir, path);
    try {
      const input = yaml.load(await readFile(path, "utf8"));
      const parsed = agentConfigSchema.safeParse(input);
      if (parsed.success) {
        agents.push(parsed.data);
      } else {
        issues.push(...schemaIssues(file, parsed.error.issues));
      }
    } catch (error) {
      issues.push({ file, message: errorMessage(error) });
    }
  }

  for (const path of skillFiles) {
    const file = toRelativePath(workingDir, path);
    try {
      const contents = await readFile(path, "utf8");
      const parsedMarkdown = parseSkillMarkdown(contents, file, path);
      const parsed = skillConfigSchema.safeParse(parsedMarkdown);
      if (parsed.success) {
        skills.push(parsed.data);
      } else {
        issues.push(...schemaIssues(file, parsed.error.issues));
      }
    } catch (error) {
      const extracted = extractErrorIssues(file, error);
      issues.push(...(extracted.length > 0 ? extracted : [{ file, message: errorMessage(error) }]));
    }
  }

  if (issues.length > 0) {
    throw new WorkingCopyValidationError(issues);
  }
  return {
    ...(manifest.defaultAgentName === undefined
      ? {}
      : { defaultAgentName: manifest.defaultAgentName }),
    agents,
    skills
  };
}

export async function matchManifestFiles(root: string, patterns: string[]): Promise<string[]> {
  const normalizedPatterns = patterns.map(validateGlob);
  if (normalizedPatterns.length === 0) {
    return [];
  }
  const matches = new Set<string>();
  for (const pattern of normalizedPatterns) {
    const files: string[] = [];
    await walkFiles(root, globSearchRoot(root, pattern), files);
    const regex = globPatternToRegExp(pattern);
    for (const path of files) {
      if (regex.test(toRelativePath(root, path))) {
        matches.add(path);
      }
    }
  }
  return [...matches].sort((left, right) => left.localeCompare(right));
}

export function agentAssetPath(workingDir: string, name: string): string {
  assertSafeAssetName(name);
  return resolve(workingDir, "agents", `${name}.agent.yaml`);
}

export function skillAssetPath(workingDir: string, name: string): string {
  assertSafeAssetName(name);
  return resolve(workingDir, "skills", name, "SKILL.md");
}

export async function removeStaleManifestAssets(
  workingDir: string,
  manifest: CatalystManifest,
  desiredPaths: Set<string>
): Promise<void> {
  const existing = await matchManifestFiles(workingDir, [...manifest.agents, ...manifest.skills]);
  for (const path of existing) {
    if (desiredPaths.has(path)) {
      continue;
    }
    await rm(path);
    const parent = dirname(path);
    if (parent !== workingDir) {
      try {
        await rmdir(parent);
      } catch (error) {
        if (!isNodeError(error) || (error.code !== "ENOTEMPTY" && error.code !== "EEXIST")) {
          throw error;
        }
      }
    }
  }
}

export async function updateManifestDefaultAgent(
  path: string,
  defaultAgentName: string | undefined
): Promise<void> {
  const contents = await readFile(path, "utf8");
  const linePattern = /^defaultAgentName:[^\r\n]*(?:\r?\n|$)/mu;
  let updated: string;
  if (defaultAgentName === undefined) {
    updated = contents.replace(linePattern, "");
  } else {
    const line = yaml.dump({ defaultAgentName }, { lineWidth: -1, noCompatMode: true }).trimEnd();
    if (linePattern.test(contents)) {
      updated = contents.replace(linePattern, `${line}\n`);
    } else {
      const defaultInstancePattern = /^defaultInstance:[^\r\n]*(?:\r?\n|$)/mu;
      updated = defaultInstancePattern.test(contents)
        ? contents.replace(defaultInstancePattern, (match) => `${match}${line}\n`)
        : `${contents.trimEnd()}\n${line}\n`;
    }
  }
  await writeFile(path, updated, "utf8");
}

async function walkFiles(root: string, directory: string, output: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (directory !== root && isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === root && [".git", "node_modules"].includes(entry.name)) {
        continue;
      }
      await walkFiles(root, path, output);
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
}

function globSearchRoot(root: string, pattern: string): string {
  const wildcardIndex = pattern.search(/[?*]/u);
  const fixedPart = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  const slashIndex = fixedPart.lastIndexOf("/");
  return resolve(root, slashIndex === -1 ? "." : fixedPart.slice(0, slashIndex));
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u");
}

function validateGlob(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  if (isAbsolute(pattern) || normalized.split("/").includes("..")) {
    throw new Error(`Manifest glob must stay within the working-copy directory: ${pattern}`);
  }
  return normalized.replace(/^\.\//u, "");
}

function normalizeUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return value.replace(/\/+$/u, "");
}

function readOptionalString(
  input: Record<string, unknown>,
  key: string,
  source: string
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} ${key} must be a non-empty string`);
  }
  return value;
}

function readStringArray(input: Record<string, unknown>, key: string, source: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${source} ${key} must be an array of file globs`);
  }
  return value;
}

function assertSafeAssetName(name: string): void {
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`Config asset name cannot be represented safely as a local path: ${name}`);
  }
}

function schemaIssues(
  file: string,
  issues: Array<{ message: string; path: PropertyKey[] }>
): WorkingCopyIssue[] {
  return issues.map((issue) => ({
    file,
    message: issue.message,
    ...(issue.path.length === 0 ? {} : { path: issue.path.map(String).join(".") })
  }));
}

function extractErrorIssues(file: string, error: unknown): WorkingCopyIssue[] {
  if (!isRecord(error) || !isRecord(error.details) || !Array.isArray(error.details.issues)) {
    return [];
  }
  return error.details.issues.flatMap((issue) => {
    if (!isRecord(issue) || typeof issue.message !== "string") {
      return [];
    }
    const path = Array.isArray(issue.path) ? issue.path.map(String).join(".") : undefined;
    return [{ file, message: issue.message, ...(path ? { path } : {}) }];
  });
}

function toRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
