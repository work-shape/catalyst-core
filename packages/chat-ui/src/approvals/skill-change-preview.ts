export type SkillChangeType = "replace" | "add" | "new_resource";

export interface SkillChangePreviewChange {
  type: SkillChangeType;
  /** "root" for the skill's own instructions, otherwise a resource path. */
  target: string;
  sectionHeading?: string;
  /** Only for "replace": the whole affected paragraph(s) before the change. */
  before?: string;
  after: string;
}

export interface SkillChangePreviewNewSkill {
  name: string;
  title: string;
  description: string;
  content: string;
}

export interface SkillChangePreview {
  skillName: string;
  skillTitle: string;
  isNewSkill: boolean;
  changes: SkillChangePreviewChange[];
  newSkill?: SkillChangePreviewNewSkill;
}

export const SKILL_ROOT_TARGET = "root";

/**
 * The preview is produced by the skill-change handler on the server. A missing
 * or malformed preview yields `undefined` so the card falls back to the
 * request summary instead of rendering half a change.
 */
export function parseSkillChangePreview(preview: unknown): SkillChangePreview | undefined {
  if (!isRecord(preview)) {
    return undefined;
  }
  const changes = Array.isArray(preview.changes)
    ? preview.changes.flatMap((change) => parseChange(change) ?? [])
    : [];
  const newSkill = parseNewSkill(preview.newSkill);
  const skillName = readText(preview.skillName) ?? newSkill?.name;
  const skillTitle = readText(preview.skillTitle) ?? newSkill?.title ?? skillName;
  if (!skillTitle || (changes.length === 0 && !newSkill)) {
    return undefined;
  }
  return {
    skillName: skillName ?? skillTitle,
    skillTitle,
    isNewSkill: preview.isNewSkill === true || (newSkill !== undefined && changes.length === 0),
    changes,
    ...(newSkill ? { newSkill } : {})
  };
}

function parseChange(value: unknown): SkillChangePreviewChange | undefined {
  if (!isRecord(value) || !isChangeType(value.type) || typeof value.after !== "string") {
    return undefined;
  }
  const sectionHeading = readText(value.sectionHeading);
  return {
    type: value.type,
    target: readText(value.target) ?? SKILL_ROOT_TARGET,
    after: value.after,
    ...(sectionHeading ? { sectionHeading } : {}),
    ...(value.type === "replace" && typeof value.before === "string"
      ? { before: value.before }
      : {})
  };
}

function parseNewSkill(value: unknown): SkillChangePreviewNewSkill | undefined {
  if (!isRecord(value) || typeof value.content !== "string") {
    return undefined;
  }
  const name = readText(value.name);
  const title = readText(value.title) ?? name;
  if (!title) {
    return undefined;
  }
  return {
    name: name ?? title,
    title,
    description: readText(value.description) ?? "",
    content: value.content
  };
}

function isChangeType(value: unknown): value is SkillChangeType {
  return value === "replace" || value === "add" || value === "new_resource";
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
