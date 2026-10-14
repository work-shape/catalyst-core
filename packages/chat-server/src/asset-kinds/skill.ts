import {
  SKILL_NAME_PATTERN,
  SKILL_NAME_RULE,
  skillConfigSchema,
  skillPortabilityIssues,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import { AppError, defineAssetKind } from "@vivd-catalyst/core";
import { z } from "zod";
import {
  SKILL_MANIFEST_FILE,
  readSkillFiles,
  skillFileIndex,
  skillFileSetManifest,
  skillFilesOfConfig,
  storedFileMatchesConfig,
  withCarriedSkillParts,
  withSkillFileIndex
} from "../skill-files";
import { readDefinitionField, readDefinitionName, type WorkflowAssetKind } from "./shared";

/**
 * The refusal of every write to a skill that ships with the platform: a release replaces it,
 * and nothing else changes or deletes it. Its name is taken while it ships.
 */
function shippedSkillRefusal(name: string | undefined): AppError {
  return new AppError(
    "FORBIDDEN",
    `The skill '${name ?? ""}' ships with the platform and is read-only. Copy it to edit it, under a name of your own`,
    { reason: "shipped_skill" }
  );
}

/**
 * The skill kind: text an agent reads, with its resources, and the files of its folder beside
 * them. It refers to nothing. A skill that ships with the platform names `origin: release` and
 * its icon. The release seed alone writes it, so every other write that carries either is
 * refused.
 *
 * `shippedSkillNames` names every skill the platform ships, also those of a module that is
 * off: a skill of the instance's own under one of them would stop the start that turns the
 * module on.
 */
export function createSkillAssetKind(options: {
  config: ClientInstanceConfig;
  shippedSkillNames: readonly string[];
}): WorkflowAssetKind {
  const shipped = new Set(options.shippedSkillNames);
  const assertEditingAllowed = () => {
    if (!options.config.administration.agentConfiguration.allowSkillEditing) {
      throw new AppError("FORBIDDEN", "Interactive skill editing is disabled");
    }
  };
  return {
    ...defineAssetKind({
      kind: "skill",
      plural: "skills",
      schema: skillConfigSchema,
      nameRule: { pattern: SKILL_NAME_PATTERN, description: SKILL_NAME_RULE },
      actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" },
      // The instance owns it, or the workspace it was made in (WS-OWN-1a).
      owners: ["instance", "workspace"],
      validate: () => [],
      validateWrite: (context, skills) =>
        skills
          .filter((skill) => context.changes("skill", skill.name))
          .flatMap((skill) => {
            if (skill.origin !== undefined || skill.icon !== undefined) {
              return [
                {
                  message: `Only a skill that ships with the platform names an origin or an icon, and only a release writes one: leave both out of '${skill.name}'`,
                  path: [skill.origin === undefined ? "icon" : "origin"]
                }
              ];
            }
            return shipped.has(skill.name)
              ? [
                  {
                    message: `The platform ships a skill named '${skill.name}', also where its module is off: choose a name of your own`,
                    path: ["name"]
                  }
                ]
              : [];
          }),
      summarize: (skill) => ({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        attributes: {
          origin: skill.origin ?? "instance",
          ...(skill.origin === "release" && skill.icon !== undefined ? { icon: skill.icon } : {}),
          ...(skill.summary === undefined ? {} : { summary: skill.summary })
        }
      })
    }),
    inRelease: true,
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    // Asked before anything else of a write, a release's and a delete included.
    assertStoredWritable({ current }) {
      if (readDefinitionField(current, "origin") === "release") {
        throw shippedSkillRefusal(readDefinitionName(current));
      }
    },
    assertInteractiveUpsertAllowed: assertEditingAllowed,
    assertInteractiveDeleteAllowed: assertEditingAllowed,
    // A name or a description outside the public skill convention is said and not refused.
    writeWarnings: (definition) =>
      skillPortabilityIssues(
        z.object({ name: z.unknown(), description: z.unknown() }).parse(definition)
      ),
    // A skill is a folder: `SKILL.md`, its text resources, and whatever else it carries.
    revisionFiles: {
      manifestFile: SKILL_MANIFEST_FILE,
      read: readSkillFiles,
      manifestOf: skillFileSetManifest,
      indexed: (config, fileSet) => withSkillFileIndex(config, skillFileIndex(fileSet)),
      carried: withCarriedSkillParts,
      filesOfConfig: skillFilesOfConfig,
      matchesConfig: storedFileMatchesConfig
    }
  };
}
