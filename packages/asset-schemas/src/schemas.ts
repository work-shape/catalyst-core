import { z } from "zod";
import {
  REASONING_EFFORTS,
  SKILL_RESOURCE_MEDIA_TYPES,
  SKILL_STARTERS_MAX,
  SKILL_STARTER_LINE_MAX_LENGTH,
  SKILL_SUMMARY_MAX_LENGTH,
  type SkillResourceMediaType
} from "./asset-types";

const localizedStringMapSchema = z
  .object({
    en: z.string().min(1).optional(),
    de: z.string().min(1).optional()
  })
  .strict()
  .refine((value) => value.en !== undefined || value.de !== undefined, {
    message: "At least one localized value is required"
  });

export const localizedStringSchema = z.union([z.string().min(1), localizedStringMapSchema]);

// Every name of the public skill convention is one: lowercase letters, digits and hyphens.
// What a skill of this platform could be named before stays a name too.
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
export const SKILL_NAME_RULE =
  "Skill name must start with a letter or a number and contain only letters, numbers, dots, underscores, or hyphens";

/** How long a name of the public skill convention is at most, in characters. */
export const SKILL_PORTABLE_NAME_MAX_CHARS = 64;
/** How long a description of the public skill convention is at most, in characters. */
export const SKILL_PORTABLE_DESCRIPTION_MAX_CHARS = 1_024;
const SKILL_PORTABLE_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/**
 * What keeps a skill from being taken as it is into a tool that reads the public skill
 * convention: a name that is not lowercase letters, digits and single hyphens or is longer
 * than 64 characters, and a description longer than 1,024. Each is a warning with a code and
 * refuses nothing: such a skill works here.
 */
export function skillPortabilityIssues(skill: {
  name?: unknown;
  description?: unknown;
}): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  if (
    typeof skill.name === "string" &&
    (!SKILL_PORTABLE_NAME_PATTERN.test(skill.name) ||
      skill.name.length > SKILL_PORTABLE_NAME_MAX_CHARS)
  ) {
    issues.push({
      code: "skill_name_not_portable",
      message: `The name '${skill.name}' is outside the public skill convention: lowercase letters, digits and single hyphens, at most ${SKILL_PORTABLE_NAME_MAX_CHARS} characters. The skill works here and may not be taken as it is elsewhere.`
    });
  }
  if (
    typeof skill.description === "string" &&
    skill.description.length > SKILL_PORTABLE_DESCRIPTION_MAX_CHARS
  ) {
    issues.push({
      code: "skill_description_not_portable",
      message: `The description has ${skill.description.length} characters. The public skill convention takes at most ${SKILL_PORTABLE_DESCRIPTION_MAX_CHARS}.`
    });
  }
  return issues;
}

export const skillNameSchema = z
  .string()
  .min(1)
  .regex(SKILL_NAME_PATTERN, { message: SKILL_NAME_RULE });

export const skillResourcePathSchema = z
  .string()
  .min(1)
  .superRefine((path, context) => {
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path) ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Skill resource path must be a normalized relative path"
      });
    }
    if (path.toLowerCase() === "skill.md" || path.toLowerCase().endsWith("/skill.md")) {
      context.addIssue({
        code: "custom",
        message: "SKILL.md is the skill root and cannot also be a resource"
      });
    }
  });

export function skillResourceMediaTypeForPath(path: string): SkillResourceMediaType | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return undefined;
  }
}

export const skillResourceConfigSchema = z
  .object({
    path: skillResourcePathSchema,
    mediaType: z.enum(SKILL_RESOURCE_MEDIA_TYPES),
    content: z.string().refine((content) => !content.includes("\0"), {
      message: "Skill resources must contain text, not binary data"
    })
  })
  .superRefine((resource, context) => {
    const expectedMediaType = skillResourceMediaTypeForPath(resource.path);
    if (!expectedMediaType) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "Unsupported skill resource extension"
      });
    } else if (resource.mediaType !== expectedMediaType) {
      context.addIssue({
        code: "custom",
        path: ["mediaType"],
        message: `Skill resource '${resource.path}' must use media type '${expectedMediaType}'`
      });
    }
  });

/** A starter's title or hint: one short line in each language it is written in. */
const starterLineSchema = localizedStringSchema.refine(
  (value) =>
    (typeof value === "string" ? [value] : Object.values(value)).every(
      (line) => line.length <= SKILL_STARTER_LINE_MAX_LENGTH && !/[\r\n]/u.test(line)
    ),
  { message: `Must be one line of at most ${SKILL_STARTER_LINE_MAX_LENGTH} characters` }
);

export const skillStarterSchema = z.strictObject({
  title: starterLineSchema,
  hint: starterLineSchema.optional(),
  prompt: localizedStringSchema,
  tools: z.array(z.string().min(1)).optional()
});

/** One file of a skill's folder as its index names it: no content. */
export const skillFileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.number().int().min(0),
  mediaType: z.string().min(1)
});

const skillConfigObjectSchema = z.object({
  name: skillNameSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  summary: z
    .string()
    .min(1)
    .max(SKILL_SUMMARY_MAX_LENGTH, {
      message: `Skill summary must be at most ${SKILL_SUMMARY_MAX_LENGTH} characters`
    })
    .refine((summary) => !/[\r\n]/u.test(summary), {
      message: "Skill summary must be one line"
    })
    .optional(),
  starters: z
    .array(skillStarterSchema)
    .max(SKILL_STARTERS_MAX, {
      message: `A skill carries at most ${SKILL_STARTERS_MAX} starters`
    })
    .optional(),
  content: z.string().min(1),
  resources: z.array(skillResourceConfigSchema).optional(),
  files: z.array(skillFileEntrySchema).optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional()
});

export const skillConfigSchema = skillConfigObjectSchema.superRefine((skill, context) => {
  const seen = new Set<string>();
  for (const [index, resource] of (skill.resources ?? []).entries()) {
    const pathKey = resource.path.toLowerCase();
    if (seen.has(pathKey)) {
      context.addIssue({
        code: "custom",
        path: ["resources", index, "path"],
        message: `Duplicate skill resource path: ${resource.path}`
      });
    }
    seen.add(pathKey);
  }
});

/**
 * The frontmatter of a `SKILL.md`. `description` is required. `name` may be left to the folder
 * and `title` to the content. Every other key is kept as it is and never refused: the public
 * skill convention has keys of its own, such as `license` and `metadata`, and a library may
 * add more.
 */
export const skillFileFrontmatterSchema = z.looseObject({
  name: skillNameSchema.optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1)
});

const welcomeSubtitleSchema = z.union([
  z.string(),
  z
    .object({
      en: z.string().optional(),
      de: z.string().optional()
    })
    .strict()
    .refine((value) => value.en !== undefined || value.de !== undefined, {
      message: "At least one localized value is required"
    })
]);

/**
 * An agent's id is a segment of its address. A browser reads `.` and `..` as "this place" and
 * "one up" and drops them from a path, so an agent with either name could not be opened.
 */
const agentNameSchema = z
  .string()
  .min(1)
  .refine((name) => name !== "." && name !== "..", {
    message: "Agent name must not be '.' or '..'"
  });

export const agentConfigSchema = z.object({
  name: agentNameSchema,
  displayName: localizedStringSchema,
  description: localizedStringSchema.optional(),
  welcomeMessage: localizedStringSchema.optional(),
  welcomeSubtitle: welcomeSubtitleSchema.optional(),
  instructions: z.string().min(1),
  modelProviderId: z.string().min(1).optional(),
  modelBindingId: z.string().min(1).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  fastMode: z.boolean().optional(),
  userSelectableModelBindingIds: z.array(z.string().min(1)).optional(),
  modelReasoningEfforts: z.record(z.string().min(1), z.enum(REASONING_EFFORTS)).optional(),
  maxSteps: z.number().int().positive().optional(),
  toolNames: z.array(z.string().min(1)).default([]),
  skillNames: z.array(skillNameSchema).default([]),
  initialPrompts: z
    .array(
      z.object({
        title: localizedStringSchema,
        prompt: localizedStringSchema
      })
    )
    .default([])
});

/** The id of a Workflow, which is the name of its asset: part of `workflow.<id>.start`. */
export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/u;
export const WORKFLOW_NAME_RULE =
  "A Workflow id starts with a lowercase letter and holds lowercase letters, digits, '_' and '-', at most 63 characters";

/**
 * What a revision of a Workflow holds as its config: the id the asset is addressed by,
 * `workflow.yaml` as an object under `manifest`, and the files of its `steps/` folder under
 * `files`, each with its path in the Workflow's folder and its text. This is the shape alone,
 * which every stored revision keeps whatever a later engine accepts. Whether the engine of the
 * instance runs the manifest and takes the files is asked of the engine when a revision is
 * saved and when one is published.
 */
export const workflowConfigSchema = z.strictObject({
  name: z.string(),
  manifest: z.looseObject({
    id: z.string(),
    name: z.string().min(1),
    description: z.string().optional()
  }),
  files: z.array(z.strictObject({ path: z.string(), content: z.string() })).optional()
});

export type WorkflowAssetConfig = z.infer<typeof workflowConfigSchema>;
