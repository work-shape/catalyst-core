import type { z } from "zod";
import { skillFileFrontmatterSchema } from "./schemas";
import { readYamlData } from "./yaml-data";

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
 * without a name takes it from its folder, or from its own file name. `skillPath` separates
 * its segments with `/`. This module runs in a browser too, so it reads the path as text.
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

  const frontmatterRaw = readYamlData(match[1] ?? "", skillFile);
  if (!frontmatterRaw.ok) {
    throw new SkillMarkdownError(frontmatterRaw.issue.message);
  }
  const frontmatter = skillFileFrontmatterSchema.safeParse(frontmatterRaw.value);
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
  const filename = lastSegment(skillPath);
  const sourceName =
    filename.toLowerCase() === "skill.md"
      ? lastSegment(parentPath(skillPath))
      : withoutExtension(filename);
  return sourceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function withoutTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") {
    end -= 1;
  }
  return path.slice(0, end);
}

function lastSegment(path: string): string {
  const trimmed = withoutTrailingSeparators(path);
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function parentPath(path: string): string {
  const trimmed = withoutTrailingSeparators(path);
  return trimmed.slice(0, Math.max(trimmed.lastIndexOf("/"), 0));
}

/** A leading dot starts a hidden file's name, not an extension. */
function withoutExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
