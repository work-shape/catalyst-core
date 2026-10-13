import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import yaml from "js-yaml";
import {
  parseSkillMarkdown as parseSkillFileMarkdown,
  SkillMarkdownError
} from "@vivd-catalyst/asset-schemas";
import { AppError } from "@vivd-catalyst/core";
import {
  clientInstanceConfigFileSchema,
  uiConfigOverlaySchema,
  uiConfigSchema,
  type ClientInstanceConfig
} from "./schemas";
import { withoutRemovedWorkspaceSwitch } from "./removed-workspace-switch";
import { refuseMovedInfrastructureKeys } from "./moved-infrastructure-keys";
import { withApprovalChecksAsGuardrails } from "./approval-checks-transition";
import { invalidConfigError, parseClientInstanceConfig } from "./validation";

export async function loadClientInstanceConfigFromFile(
  path: string
): Promise<ClientInstanceConfig> {
  const raw = withApprovalChecksAsGuardrails(
    await readConfigFileWithExtends(resolve(path), new Set())
  );
  refuseMovedInfrastructureKeys(raw);
  const hasInlineUi = hasOwnProperty(raw, "ui");
  const parsed = clientInstanceConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidConfigError("Client instance config is invalid", parsed.error.issues);
  }

  const baseDir = dirname(path);
  const inlineUi = withoutRemovedWorkspaceSwitch(parsed.data.ui);
  if (parsed.data.uiFile && hasInlineUi) {
    const overlay = uiConfigOverlaySchema.safeParse(inlineUi);
    if (!overlay.success) {
      throw new AppError("VALIDATION_FAILED", "Inline UI config overlay is invalid", {
        issues: overlay.error.issues
      });
    }
  }

  const fileUi = parsed.data.uiFile
    ? await loadUiConfigFile(baseDir, parsed.data.uiFile, hasInlineUi ? inlineUi : undefined)
    : hasInlineUi
      ? inlineUi
      : undefined;

  return parseClientInstanceConfig({
    ...parsed.data,
    ui: fileUi
  });
}

async function loadUiConfigFile(baseDir: string, uiFile: string, overlay?: unknown) {
  const uiPath = resolve(baseDir, uiFile);
  const uiRaw = withoutRemovedWorkspaceSwitch(await readStructuredFile(uiPath));
  const mergedUi =
    isPlainObject(uiRaw) && isPlainObject(overlay)
      ? mergeConfigObjects(uiRaw, overlay)
      : (overlay ?? uiRaw);
  const ui = uiConfigSchema.safeParse(mergedUi);
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
    if (key === "__proto__") {
      continue;
    }
    const baseValue = result[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(override)
        ? mergeConfigObjects(baseValue, override)
        : override;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Exclude arrays and YAML-derived non-record objects such as Date: those
  // replace the base value wholesale instead of merging into it.
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads a `SKILL.md`. A file that is no skill is refused as a validation failure. */
export function parseSkillMarkdown(
  contents: string,
  skillFile: string,
  skillPath: string
): unknown {
  try {
    return parseSkillFileMarkdown(contents, skillFile, skillPath);
  } catch (error) {
    if (error instanceof SkillMarkdownError) {
      throw new AppError("VALIDATION_FAILED", error.message, error.details);
    }
    throw error;
  }
}

function hasOwnProperty(input: unknown, key: string): boolean {
  return (
    typeof input === "object" && input !== null && Object.prototype.hasOwnProperty.call(input, key)
  );
}
