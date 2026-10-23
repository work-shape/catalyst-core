import { createHash } from "node:crypto";
import { skillConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  type ClientInstanceId,
  type ObjectStorage,
  type PlatformStores,
  type SkillFolderReader
} from "@work-shape/catalyst-core";
import { createSkillSourceVersion } from "@work-shape/catalyst-tool-execution";
import { SKILL_REVISION_FILES } from "../asset-kinds/skill";
import { readRevisionFolder } from "../assets/asset-files";

/**
 * Reads the folder of one revision of a skill of this instance for the command worker, with
 * the read `assets.get files=true` answers: `SKILL.md`, its text resources and every file of
 * its file set. It reads the revision a command recorded, not the live one, and refuses a
 * revision of another instance, a deleted one, or one whose version is not the recorded one.
 * It answers no rights: the command was given its skills when it was queued.
 */
export function createSkillFolderReader(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  /** The instance's `files` store. Without it a skill holds its text alone. */
  files?: ObjectStorage;
}): SkillFolderReader {
  return {
    async read(input) {
      if (input.clientInstanceId !== options.clientInstanceId) {
        throw new AppError("FORBIDDEN", "A skill folder is read for its own instance only");
      }
      const revision = await options.stores.configAssets.getConfigAssetRevision({
        clientInstanceId: options.clientInstanceId,
        kind: "skill",
        name: input.name,
        revision: input.revision
      });
      if (!revision?.config) {
        throw new AppError("NOT_FOUND", `Revision ${input.revision} of the skill is not stored`, {
          reason: "skill_revision_missing"
        });
      }
      const skill = skillConfigSchema.parse(revision.config);
      if (skill.name !== input.name) {
        throw new AppError("NOT_FOUND", "The revision is not one of this skill", {
          reason: "skill_revision_missing"
        });
      }
      if (
        input.sourceVersion !== undefined &&
        createSkillSourceVersion(skill) !== input.sourceVersion
      ) {
        throw new AppError("CONFLICT", "The revision is not the version the command recorded", {
          reason: "skill_version_changed"
        });
      }
      const { files } = await readRevisionFolder(
        {
          clientInstanceId: options.clientInstanceId,
          stores: options.stores,
          ...(options.files ? { pages: { objects: options.files } } : {})
        },
        { revisionFiles: SKILL_REVISION_FILES },
        {
          assetId: revision.assetId,
          config: revision.config,
          ...(revision.fileSetId ? { fileSetId: revision.fileSetId } : {})
        }
      );
      return files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: createHash("sha256").update(file.bytes).digest("hex")
      }));
    }
  };
}
