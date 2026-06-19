import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import yaml from "js-yaml";
import { AppError } from "@vivd-catalyst/core";
import {
  agentConfigSchema,
  clientInstanceConfigFileSchema,
  skillConfigSchema,
  skillFileFrontmatterSchema,
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
  const fileSkills = await Promise.all(
    parsed.data.skillFiles.map((skillFile) => loadSkillFile(baseDir, skillFile))
  );

  return parseClientInstanceConfig({
    ...parsed.data,
    ui: fileUi,
    agents: [...parsed.data.agents, ...fileAgents],
    skills: [...parsed.data.skills, ...fileSkills]
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

async function loadSkillFile(baseDir: string, skillFile: string) {
  const skillPath = resolve(baseDir, skillFile);
  const contents = await readFile(skillPath, "utf8");
  const parsed = parseSkillMarkdown(contents, skillFile, skillPath);
  const skill = skillConfigSchema.safeParse(parsed);
  if (!skill.success) {
    throw new AppError("VALIDATION_FAILED", `Skill file '${skillFile}' is invalid`, {
      issues: skill.error.issues
    });
  }
  return skill.data;
}

function parseSkillMarkdown(contents: string, skillFile: string, skillPath: string): unknown {
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
