import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import yaml from "js-yaml";
import { AppError } from "@vivd-stage/core";
import {
  agentConfigSchema,
  clientInstanceConfigFileSchema,
  uiConfigSchema,
  type ClientInstanceConfig
} from "./schemas";
import { parseClientInstanceConfig } from "./validation";

export async function loadClientInstanceConfigFromFile(
  path: string
): Promise<ClientInstanceConfig> {
  const raw = await readStructuredFile(path);
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
  const fileAgents = await Promise.all(
    parsed.data.agentFiles.map(async (agentFile) => {
      const agentPath = resolve(baseDir, agentFile);
      const agentRaw = await readStructuredFile(agentPath);
      const agent = agentConfigSchema.safeParse(agentRaw);
      if (!agent.success) {
        throw new AppError("VALIDATION_FAILED", `Agent config '${agentFile}' is invalid`, {
          issues: agent.error.issues
        });
      }
      return agent.data;
    })
  );

  return parseClientInstanceConfig({
    ...parsed.data,
    ui: fileUi,
    agents: [...parsed.data.agents, ...fileAgents]
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

function hasOwnProperty(input: unknown, key: string): boolean {
  return typeof input === "object" && input !== null && Object.prototype.hasOwnProperty.call(input, key);
}
