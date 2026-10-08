import { z } from "zod";
import {
  AppError,
  type AgentConfig,
  type AgentSkillChangesPolicy,
  type SkillConfig
} from "@vivd-catalyst/core";
import {
  skillConfigSchema,
  skillNameSchema,
  skillResourcePathSchema,
  skillResourceMediaTypeForPath
} from "./schemas";

export const SKILL_CHANGE_MAX_OPERATION_TEXT = 20_000;
export const SKILL_CHANGE_MAX_CONTENT = 60_000;
export const SKILL_CHANGE_MAX_RESOURCES = 30;
const text = z.string().max(SKILL_CHANGE_MAX_OPERATION_TEXT);
const target = z.union([z.literal("root"), skillResourcePathSchema]);
export const skillChangeOperationSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("replace_text"), target, oldText: text.min(1), newText: text })
    .strict(),
  z
    .object({
      type: z.literal("append_text"),
      target,
      sectionHeading: text.min(1).optional(),
      text: text.min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal("create_resource"),
      resourcePath: skillResourcePathSchema,
      content: text
    })
    .strict(),
  z
    .object({
      type: z.literal("create_skill"),
      name: skillNameSchema,
      title: text.min(1),
      description: text.min(1),
      content: text.min(1)
    })
    .strict()
]);
export const skillChangeOperationsSchema = z
  .array(skillChangeOperationSchema)
  .min(1)
  .superRefine((operations, ctx) => {
    const creations = operations.filter((op) => op.type === "create_skill");
    if (creations.length === 0) {
      return;
    }
    if (creations.length > 1 || operations[0]?.type !== "create_skill") {
      ctx.addIssue({
        code: "custom",
        message: "create_skill must be the first operation and occur only once"
      });
    }
    if (operations.slice(1).some((op) => op.type !== "create_resource")) {
      ctx.addIssue({
        code: "custom",
        message: "create_skill can only be followed by create_resource operations"
      });
    }
  });
export type SkillChangeOperation = z.infer<typeof skillChangeOperationSchema>;
export interface SkillChangePreview {
  skillName: string;
  skillTitle: string;
  isNewSkill: boolean;
  changes: Array<{
    type: "replace" | "add" | "new_resource";
    target: string;
    sectionHeading?: string;
    before?: string;
    after: string;
  }>;
  newSkill?: { name: string; title: string; description: string; content: string };
}

export function assertSkillChangeScope(input: {
  policy: AgentSkillChangesPolicy;
  agent: AgentConfig | undefined;
  skillName: string;
  operations: readonly SkillChangeOperation[];
}): void {
  if (!input.policy.enabled) {
    throw new AppError("FORBIDDEN", "Agent skill changes are disabled");
  }
  if (!input.agent) {
    throw new AppError("VALIDATION_FAILED", "The proposing agent does not exist");
  }
  const creation = input.operations.find((op) => op.type === "create_skill");
  if (creation) {
    if (!input.policy.allowSkillCreation) {
      throw new AppError("FORBIDDEN", "Agent skill creation is disabled");
    }
    if (creation.name !== input.skillName) {
      fail("create_skill name must match skillName");
    }
  } else if (!input.agent.skillNames.includes(input.skillName)) {
    throw new AppError(
      "FORBIDDEN",
      `Skill '${input.skillName}' is outside agent '${input.agent.name}' scope`
    );
  }
}

export function applySkillChange(
  skill: SkillConfig | undefined,
  operations: readonly SkillChangeOperation[]
): SkillConfig {
  return evaluate(skill, operations).skill;
}
export function createSkillChangePreview(
  skill: SkillConfig | undefined,
  operations: readonly SkillChangeOperation[]
): SkillChangePreview {
  return evaluate(skill, operations).preview;
}

function evaluate(
  original: SkillConfig | undefined,
  input: readonly SkillChangeOperation[]
): { skill: SkillConfig; preview: SkillChangePreview } {
  const parsed = skillChangeOperationsSchema.safeParse(input);
  if (!parsed.success) {
    fail(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  }
  const operations = parsed.data;
  const creation = operations[0];
  let skill: SkillConfig;
  if (creation?.type === "create_skill") {
    if (original) {
      fail(`Skill '${original.name}' already exists`);
    }
    const { type: _type, ...config } = creation;
    skill = config;
  } else {
    if (!original) {
      fail("Target skill does not exist");
    }
    skill = structuredClone(original);
  }
  const preview: SkillChangePreview = {
    skillName: skill.name,
    skillTitle: skill.title,
    isNewSkill: creation?.type === "create_skill",
    changes: []
  };
  for (const op of operations) {
    if (op.type === "create_skill") {
      preview.newSkill = {
        name: skill.name,
        title: skill.title,
        description: skill.description,
        content: skill.content
      };
    } else if (op.type === "create_resource") {
      if (
        skill.resources?.some(
          (resource) => resource.path.toLowerCase() === op.resourcePath.toLowerCase()
        )
      ) {
        fail(`Resource '${op.resourcePath}' already exists`);
      }
      const mediaType = skillResourceMediaTypeForPath(op.resourcePath);
      if (!mediaType) {
        fail(`Unsupported skill resource extension: '${op.resourcePath}'`);
      }
      skill.resources = [
        ...(skill.resources ?? []),
        { path: op.resourcePath, mediaType, content: op.content }
      ];
      preview.changes.push({ type: "new_resource", target: op.resourcePath, after: op.content });
    } else {
      const resource =
        op.target === "root"
          ? undefined
          : skill.resources?.find((resource) => resource.path === op.target);
      if (op.target !== "root" && !resource) {
        fail(`Target resource '${op.target}' does not exist`);
      }
      const before = resource ? resource.content : skill.content;
      let after: string;
      if (op.type === "replace_text") {
        const index = before.indexOf(op.oldText);
        if (index < 0 || before.indexOf(op.oldText, index + 1) !== -1) {
          fail(`oldText must occur exactly once in '${op.target}'`);
        }
        after = before.slice(0, index) + op.newText + before.slice(index + op.oldText.length);
        const [start, end] = paragraphBounds(before, index, index + op.oldText.length);
        preview.changes.push({
          type: "replace",
          target: op.target,
          before: before.slice(start, end),
          after: after.slice(start, end + op.newText.length - op.oldText.length)
        });
      } else {
        const index = op.sectionHeading ? sectionEnd(before, op.sectionHeading) : before.length;
        const prefix = before.slice(0, index);
        const suffix = before.slice(index);
        after =
          prefix +
          (prefix && !prefix.endsWith("\n\n") ? (prefix.endsWith("\n") ? "\n" : "\n\n") : "") +
          op.text +
          (suffix ? "\n\n" : "") +
          suffix;
        preview.changes.push({
          type: "add",
          target: op.target,
          ...(op.sectionHeading ? { sectionHeading: op.sectionHeading } : {}),
          after: op.text
        });
      }
      if (resource) {
        resource.content = after;
      } else {
        skill.content = after;
      }
    }
    if (skill.content.length > SKILL_CHANGE_MAX_CONTENT) {
      fail(`Skill root exceeds ${SKILL_CHANGE_MAX_CONTENT} characters`);
    }
    if ((skill.resources?.length ?? 0) > SKILL_CHANGE_MAX_RESOURCES) {
      fail(`Skill exceeds ${SKILL_CHANGE_MAX_RESOURCES} resources`);
    }
    for (const resource of skill.resources ?? []) {
      if (resource.content.length > SKILL_CHANGE_MAX_CONTENT) {
        fail(`Resource '${resource.path}' exceeds ${SKILL_CHANGE_MAX_CONTENT} characters`);
      }
    }
  }
  const validated = skillConfigSchema.safeParse(skill);
  if (!validated.success) {
    fail(validated.error.issues.map((issue) => issue.message).join("; "));
  }
  return { skill: validated.data, preview };
}

function fail(message: string): never {
  throw new AppError("VALIDATION_FAILED", message);
}

function paragraphBounds(content: string, from: number, to: number): [number, number] {
  let start = 0;
  for (const match of content.matchAll(/\r?\n[\t ]*\r?\n/g)) {
    const end = match.index + match[0].length;
    if (end <= from) {
      start = end;
    }
    if (match.index >= to) {
      return [start, match.index];
    }
  }
  return [start, content.length];
}

function sectionEnd(content: string, heading: string): number {
  // ATX Markdown headings; ignore headings inside fenced code blocks.
  const headings: Array<{ text: string; level: number; index: number }> = [];
  let offset = 0;
  let fence: string | undefined;
  for (const line of content.split(/(?<=\n)/u)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
    } else if (!fence) {
      const match = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/u.exec(line);
      if (match?.[1] && match[2]) {
        headings.push({ text: match[2], level: match[1].length, index: offset });
      }
    }
    offset += line.length;
  }
  const label = heading
    .replace(/^#{1,6}\s+/u, "")
    .replace(/\s+#+$/u, "")
    .trim();
  const matches = headings.filter((candidate) => candidate.text === label);
  const found = matches[0];
  if (!found) {
    fail(`Section heading '${heading}' does not exist`);
  }
  if (matches.length !== 1) {
    fail(`Section heading '${heading}' is ambiguous`);
  }
  return (
    headings.find((candidate) => candidate.index > found.index && candidate.level <= found.level)
      ?.index ?? content.length
  );
}
