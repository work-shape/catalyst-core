import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const storageEvents = {
  "storage.orphaned_file_cleanup_failed": {
    ...LEGACY_AUDIT,
    name: "storage.orphaned_file_cleanup_failed",
    subject: "storage"
  },
  "storage.orphaned_files_deleted": {
    ...LEGACY_AUDIT,
    name: "storage.orphaned_files_deleted",
    subject: "storage"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
