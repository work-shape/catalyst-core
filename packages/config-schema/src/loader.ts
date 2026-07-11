import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import yaml from "js-yaml";
import { AppError } from "@vivd-catalyst/core";
import {
  clientInstanceConfigFileSchema,
  skillFileFrontmatterSchema,
  uiConfigSchema,
  type ClientInstanceConfig
} from "./schemas";
import { parseClientInstanceConfig } from "./validation";

export async function loadClientInstanceConfigFromFile(
  path: string
): Promise<ClientInstanceConfig> {
  const raw = await readConfigFileWithExtends(resolve(path), new Set());
  const hasInlineUi = hasOwnProperty(raw, "ui");
  const parsed = clientInstanceConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Client instance config is invalid", {
      issues: parsed.error.issues
    });
  }

  const baseDir = dirname(path);
  if (parsed.data.uiFile && hasInlineUi) {
    throw new AppError("VALIDATION_FAILED", "Use either ui or uiFile in client instance config, not both");
  }

  const fileUi = parsed.data.uiFile
    ? await loadUiConfigFile(baseDir, parsed.data.uiFile)
    : hasInlineUi
      ? parsed.data.ui
      : undefined;

  return parseClientInstanceConfig({
    ...parsed.data,
    ui: fileUi
  });
}

async function loadUiConfigFile(baseDir: string, uiFile: string) {
  const uiPath = resolve(baseDir, uiFile);
  const uiRaw = await readStructuredFile(uiPath);
  const ui = uiConfigSchema.safeParse(uiRaw);
  if (!ui.success) {
    throw new AppError("VALIDATION_FAILED", `UI config '${uiFile}' is invalid`, {
      issues: ui.error.issues
    });
  }
  return ui.data;
}

async function readStructuredFile(path: string): Promise<unknown> {
  const contents = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();
  return extension === ".json" ? JSON.parse(contents) : yaml.load(contents);
}

/**
 * Reads a config file, resolving an optional top-level `extends: <relative path>`
 * against another config file. Objects merge recursively with the extending file
 * winning; arrays and scalars replace the base value wholesale. Relative paths in
 * the merged result (such as `uiFile`) always resolve against the entry file's
 * directory, not the extended file's.
 */
async function readConfigFileWithExtends(path: string, visited: Set<string>): Promise<unknown> {
  if (visited.has(path)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config file extends cycle detected: ${[...visited, path].join(" -> ")}`
    );
  }
  visited.add(path);

  const raw = await readStructuredFile(path);
  if (!isPlainObject(raw) || !("extends" in raw)) {
    return raw;
  }
  const { extends: extendsValue, ...overrides } = raw;
  if (typeof extendsValue !== "string" || extendsValue.length === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config file '${path}' has an invalid extends value; expected a relative file path`
    );
  }
  const base = await readConfigFileWithExtends(resolve(dirname(path), extendsValue), visited);
  if (!isPlainObject(base)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config file '${extendsValue}' extended from '${path}' must contain an object`
    );
  }
  return mergeConfigObjects(base, overrides);
}

function mergeConfigObjects(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, override] of Object.entries(overrides)) {
    const baseValue = result[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(override)
        ? mergeConfigObjects(baseValue, override)
        : override;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSkillMarkdown(contents: string, skillFile: string, skillPath: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(contents);
  if (!match) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Skill file '${skillFile}' must start with YAML frontmatter`
    );
  }

  const frontmatterRaw = yaml.load(match[1] ?? "");
  const frontmatter = skillFileFrontmatterSchema.safeParse(frontmatterRaw);
  if (!frontmatter.success) {
    throw new AppError("VALIDATION_FAILED", `Skill file '${skillFile}' frontmatter is invalid`, {
      issues: frontmatter.error.issues
    });
  }

  const content = (match[2] ?? "").trim();
  return {
    ...frontmatter.data,
    name: frontmatter.data.name ?? deriveSkillName(skillPath),
    content
  };
}

function deriveSkillName(skillPath: string): string {
  const extension = extname(skillPath);
  const filename = basename(skillPath);
  const sourceName =
    filename.toLowerCase() === "skill.md" ? basename(dirname(skillPath)) : basename(skillPath, extension);
  return sourceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function hasOwnProperty(input: unknown, key: string): boolean {
  return typeof input === "object" && input !== null && Object.prototype.hasOwnProperty.call(input, key);
}
