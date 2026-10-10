import { z } from "zod";
import { defineProvider } from "@vivd-catalyst/core";
import { DockerWorkspaceCommandProcessExecutor } from "../docker-workspace-command-runner";

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
   * A network endpoint of a Docker engine on another host. With it the entry must state a
   * `region`. A socket path or any other host path is not accepted: absent means the Docker
   * client's own default, the engine on this host.
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
  // The Docker client's own default is the engine on this host. An endpoint names another
  // host, which then receives the workspace files and must state its region.
  external: (config) => config.endpoint !== undefined,
  create(config) {
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
  async check(executor, { signal }) {
    return (await executor.engineAnswers(signal))
      ? { ok: true }
      : { ok: false, errorClass: "unreachable" };
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
