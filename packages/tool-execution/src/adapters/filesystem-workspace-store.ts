import { z } from "zod";
import { defineProvider } from "@vivd-catalyst/core";
import {
  createLocalWorkspaceFileByteStore,
  createLocalWorkspaceObjectStorage,
  type ConfiguredWorkspaceStore
} from "../workspace-file-bytes";

/** Keeps workspace bytes in a directory that the API and its workers share. */
export const filesystemWorkspaceStoreProvider = defineProvider({
  port: "objectStorage",
  type: "filesystem",
  configSchema: z.object({ root: z.string().min(1) }),
  external: false,
  create(config): ConfiguredWorkspaceStore {
    return {
      fileBytes: createLocalWorkspaceFileByteStore({ rootDirectory: config.root }),
      objects: createLocalWorkspaceObjectStorage({ rootDirectory: config.root })
    };
  },
  describe(config) {
    return { root: config.root };
  }
});
