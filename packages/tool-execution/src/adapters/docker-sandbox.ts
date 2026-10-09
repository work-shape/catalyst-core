import { z } from "zod";
import { defineProvider } from "@vivd-catalyst/core";
import { DockerWorkspaceCommandProcessExecutor } from "../docker-workspace-command-runner";
import type { WorkspaceCommandProcessExecutor } from "../workspace-command-executor";

const dockerSandboxConfigSchema = z.object({
  image: z.string().min(1),
  cpuCount: z.number().positive().default(1),
  memoryBytes: z
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024 * 1024),
  pidsLimit: z.number().int().positive().default(128),
  /**
   * A network endpoint of a Docker engine. A socket path or any other host path is not
   * accepted: absent means the Docker client's own default.
   */
  endpoint: z
    .string()
    .regex(/^(?:tcp|ssh):\/\/[^/\s]+$/u, "must be a tcp:// or ssh:// endpoint, never a path")
    .optional()
});

/**
 * Runs each workspace command in its own container. The container has no network and a
 * read-only root file system; both are fixed here and are not settings.
 */
export const dockerSandboxProvider = defineProvider({
  port: "sandbox",
  type: "docker",
  configSchema: dockerSandboxConfigSchema,
  external: false,
  create(config): WorkspaceCommandProcessExecutor {
    return new DockerWorkspaceCommandProcessExecutor({
      image: config.image,
      endpoint: config.endpoint,
      networkMode: "none",
      readOnlyRootFilesystem: true,
      cpuCount: config.cpuCount,
      memoryBytes: config.memoryBytes,
      pidsLimit: config.pidsLimit
    });
  },
  describe(config) {
    return {
      image: config.image,
      cpuCount: config.cpuCount,
      memoryBytes: config.memoryBytes,
      pidsLimit: config.pidsLimit,
      ...(config.endpoint ? { endpointHost: new URL(config.endpoint).host } : {})
    };
  }
});
