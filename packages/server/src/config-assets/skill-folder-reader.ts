import { createHash } from "node:crypto";
import { skillConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  type ClientInstanceId,
  type ObjectStorage,
  type PlatformStores,
  type SkillFolderFile,
  type SkillFolderReader
} from "@work-shape/catalyst-core";
import { createSkillSourceVersion } from "@work-shape/catalyst-tool-execution";
import { SKILL_REVISION_FILES } from "../asset-kinds/skill";
import { readRevisionFolder } from "../assets/asset-files";

/**
 * Reads the folder of one revision of a skill of this instance for the command worker, with
 * the read `assets.get files=true` answers: `SKILL.md`, its text resources and every file of
 * its file set. A Try command carries the draft definition and file set admitted with its turn.
 * Otherwise it reads the stored revision a command recorded, and refuses a
 * revision of another instance, one that is not stored, one whose version is not the recorded
 * one, and a folder whose files are not the ones the revision records: a file missing from
 * storage, other bytes, or a file it does not name. It answers no rights: the command was given
 * its skills when it was queued. It is read on a cache miss only; a command whose folder the
 * worker holds mounts it as recorded, even if the skill was deleted since it was queued.
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
      const asset = input.draft
        ? await options.stores.configAssets.getConfigAsset({
            clientInstanceId: options.clientInstanceId,
            kind: "skill",
            name: input.name
          })
        : undefined;
      const revision = input.draft
        ? asset
          ? { assetId: asset.id, config: input.draft.config, fileSetId: input.draft.fileSetId }
          : undefined
        : await options.stores.configAssets.getConfigAssetRevision({
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
      const folder = files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: createHash("sha256").update(file.bytes).digest("hex")
      }));
      matchRecordedFiles(folder, revision.config, skill.files ?? []);
      return folder;
    }
  };
}

/**
 * Refuses a folder that is not the one the revision records: each file of its index present
 * with the bytes and hash it records, and every other file one that its config holds.
 */
function matchRecordedFiles(
  folder: readonly SkillFolderFile[],
  config: unknown,
  recorded: readonly { path: string; sha256: string; bytes: number }[]
): void {
  const mismatch = () =>
    new AppError("INTERNAL", "A file of the skill is not the one its revision records", {
      reason: "skill_file_mismatch"
    });
  const read = new Map(folder.map((file) => [file.path, file]));
  for (const entry of recorded) {
    const file = read.get(entry.path);
    if (!file || file.bytes.byteLength !== entry.bytes || file.sha256 !== entry.sha256) {
      throw mismatch();
    }
  }
  const named = new Set([
    ...recorded.map((entry) => entry.path),
    ...SKILL_REVISION_FILES.filesOfConfig(config).map((file) => file.path)
  ]);
  if (folder.some((file) => !named.has(file.path))) throw mismatch();
}
