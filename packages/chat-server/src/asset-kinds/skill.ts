import {
  SKILL_NAME_PATTERN,
  SKILL_NAME_RULE,
  skillConfigSchema,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import { AppError, defineAssetKind, type SkillOrigin } from "@vivd-catalyst/core";
import {
  SKILL_MANIFEST_FILE,
  readSkillFiles,
  skillFileIndex,
  skillFileIndexOfConfig,
  skillFileSetManifest,
  skillFilesOfConfig,
  storedFileMatchesConfig,
  withSkillFileIndex
} from "../skill-files";
import type { WorkflowAssetKind } from "./shared";

/**
 * The skill kind: text an agent reads, with its resources, and the files of its folder beside
 * them. It refers to nothing.
 */
export function createSkillAssetKind(options: { config: ClientInstanceConfig }): WorkflowAssetKind {
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
      validate: () => [],
      // Every stored skill is the instance's own. A skill a release ships will say `release`
      // and name its `icon` here, both written by the release seed alone.
      summarize: (skill) => ({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        attributes: {
          origin: "instance" satisfies SkillOrigin,
          ...(skill.summary === undefined ? {} : { summary: skill.summary })
        }
      })
    }),
    inRelease: true,
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: assertEditingAllowed,
    assertInteractiveDeleteAllowed: assertEditingAllowed,
    // A skill is a folder: `SKILL.md`, its text resources, and whatever else it carries.
    revisionFiles: {
      manifestFile: SKILL_MANIFEST_FILE,
      read: readSkillFiles,
      manifestOf: skillFileSetManifest,
      indexed: (config, fileSet) => withSkillFileIndex(config, skillFileIndex(fileSet)),
      withIndexOf: (config, source) => withSkillFileIndex(config, skillFileIndexOfConfig(source)),
      filesOfConfig: skillFilesOfConfig,
      matchesConfig: storedFileMatchesConfig
    }
  };
}
