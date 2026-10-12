import { basename, dirname, extname } from "node:path";
import yaml from "js-yaml";
import type { z } from "zod";
import { skillFileFrontmatterSchema } from "./schemas";

/** A skill file that cannot be read as a skill. `details.issues` names each invalid field. */
export class SkillMarkdownError extends Error {
  readonly details?: { issues: z.core.$ZodIssue[] };

  constructor(message: string, details?: { issues: z.core.$ZodIssue[] }) {
    super(message);
    this.name = "SkillMarkdownError";
    this.details = details;
  }
}

/**
 * Reads a `SKILL.md`: YAML frontmatter with title and description, then the content. A file
 * without a name takes it from its folder, or from its own file name.
 */
export function parseSkillMarkdown(
  contents: string,
  skillFile: string,
  skillPath: string
): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(contents);
  if (!match) {
    throw new SkillMarkdownError(`Skill file '${skillFile}' must start with YAML frontmatter`);
  }

  const frontmatterRaw = yaml.load(match[1] ?? "");
  const frontmatter = skillFileFrontmatterSchema.safeParse(frontmatterRaw);
  if (!frontmatter.success) {
    throw new SkillMarkdownError(`Skill file '${skillFile}' frontmatter is invalid`, {
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
    filename.toLowerCase() === "skill.md"
      ? basename(dirname(skillPath))
      : basename(skillPath, extension);
  return sourceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}
