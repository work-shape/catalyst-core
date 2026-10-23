import { SKILL_NAME_PATTERN } from "@work-shape/catalyst-asset-schemas";
import type { ClientInstanceId } from "./ids";

/** Where a workspace command finds the folder of each skill of its run, read-only. */
export const SKILL_MOUNT_ROOT = "/skills";

/**
 * One skill a workspace command mounts at `/skills/<name>/`: the revision that was live when
 * the command was queued, and the version of what the agent reads of it then. It holds names,
 * numbers and hashes, never content.
 */
export interface WorkspaceCommandSkillMount {
  name: string;
  revision: number;
  sourceVersion: string;
}

/** Whether a name can be a folder below `/skills`: one segment of the skill name rule. */
export function isMountableSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && name.length <= 128;
}

/** One file of a skill's folder: its path relative to the folder, its bytes and their hash. */
export interface SkillFolderFile {
  path: string;
  bytes: Uint8Array;
  /** The hex SHA-256 the bytes must have, as the revision records it. */
  sha256: string;
}

/**
 * Reads the whole folder of one revision of a skill of one instance: `SKILL.md`, its text
 * resources and the files of its file set, as `assets.get files=true` answers them. A
 * revision that is not stored, that is not the skill's, or whose version is not
 * `sourceVersion` is refused, never answered with other bytes.
 */
export interface SkillFolderReader {
  read(input: {
    clientInstanceId: ClientInstanceId;
    name: string;
    revision: number;
    /** When given, the revision must have this version. */
    sourceVersion?: string;
  }): Promise<SkillFolderFile[]>;
}
