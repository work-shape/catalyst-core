import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_COMMAND_SHELL,
  DEFAULT_WORKSPACE_COMMAND_PATH,
  runSpawnedProcess,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessInput
} from "./workspace-command-executor";

const SANDBOX_ENV_KEYS = new Set(["HOME", "PATH", "TMPDIR", "WORKSPACE_DIR"]);
// Ends the version call of a check whose caller never aborts it. A provider check aborts it
// earlier, after `PROVIDER_CHECK_TIMEOUT_MS`.
const ENGINE_CHECK_TIMEOUT_SECONDS = 10;
const DEFAULT_DOCKER_WORKSPACE_COMMAND_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;

export interface DockerWorkspaceCommandProcessExecutorOptions {
  image: string;
  dockerPath?: string;
  /** The Docker endpoint, such as `tcp://host:2376`. Absent means the Docker client's default. */
  endpoint?: string;
  networkMode?: "none";
  readOnlyRootFilesystem?: boolean;
  cpuCount?: number;
  memoryBytes?: number;
  pidsLimit?: number;
  containerNamePrefix?: string;
  commandClient?: DockerCommandClient;
  createContainerName?: (input: WorkspaceCommandProcessInput) => string;
}

export interface DockerCommandClient {
  run(input: DockerCommandRunInput): Promise<ProcessResult>;
  removeContainer?(name: string): Promise<void>;
  /** The containers, running or not, whose name starts with `namePrefix`. */
  listContainers?(namePrefix: string): Promise<DockerContainerListing[]>;
  /** Whether the engine answers. A client without it is taken to answer. */
  engineAnswers?(signal: AbortSignal): Promise<boolean>;
}

export interface DockerContainerListing {
  name: string;
  /** Missing when the engine's answer could not be read as a time. */
  createdAtMs?: number;
}

export interface DockerCommandRunInput {
  args: string[];
  containerName: string;
  command: WorkspaceCommandProcessInput["command"];
  signal?: AbortSignal;
}

export interface DockerRunInvocation {
  args: string[];
  containerName: string;
  environment: Record<string, string>;
}

export class DockerWorkspaceCommandProcessExecutor implements WorkspaceCommandProcessExecutor {
  private readonly options: Required<
    Pick<
      DockerWorkspaceCommandProcessExecutorOptions,
      | "image"
      | "dockerPath"
      | "networkMode"
      | "readOnlyRootFilesystem"
      | "cpuCount"
      | "memoryBytes"
      | "pidsLimit"
      | "containerNamePrefix"
    >
  > & {
    commandClient: DockerCommandClient;
    createContainerName?: (input: WorkspaceCommandProcessInput) => string;
  };

  constructor(options: DockerWorkspaceCommandProcessExecutorOptions) {
    this.options = {
      image: options.image,
      dockerPath: options.dockerPath ?? "docker",
      networkMode: options.networkMode ?? "none",
      readOnlyRootFilesystem: options.readOnlyRootFilesystem ?? true,
      cpuCount: options.cpuCount ?? 1,
      memoryBytes: options.memoryBytes ?? DEFAULT_DOCKER_WORKSPACE_COMMAND_MEMORY_BYTES,
      pidsLimit: options.pidsLimit ?? 128,
      containerNamePrefix: options.containerNamePrefix ?? "catalyst-workspace-command",
      commandClient:
        options.commandClient ??
        new DockerCliCommandClient({
          dockerPath: options.dockerPath ?? "docker",
          endpoint: options.endpoint
        }),
      createContainerName: options.createContainerName
    };
  }

  async execute(input: WorkspaceCommandProcessInput): Promise<ProcessResult> {
    const invocation = createDockerRunInvocation(input, this.options);
    const result = await this.options.commandClient.run({
      args: invocation.args,
      containerName: invocation.containerName,
      command: input.command,
      signal: input.signal
    });
    if (result.cancelled || result.timeoutKind) {
      await this.options.commandClient.removeContainer?.(invocation.containerName);
    }
    return result;
  }

  /** Whether the Docker engine answers. It asks for the engine's version and starts nothing. */
  async engineAnswers(signal: AbortSignal): Promise<boolean> {
    return (await this.options.commandClient.engineAnswers?.(signal)) ?? true;
  }

  /**
   * A container outlives a worker that was killed: nothing is left to end it at its timeout.
   * Only containers older than `olderThanMs` are removed, so the commands of another worker on
   * the same engine, which are younger than their own timeout, stay.
   */
  async removeLeftovers(input: { idPrefix: string; olderThanMs: number }): Promise<number> {
    const { commandClient, containerNamePrefix } = this.options;
    if (!commandClient.listContainers || !commandClient.removeContainer) {
      return 0;
    }
    const prefix = sanitizeDockerName(`${containerNamePrefix}-${input.idPrefix}`);
    const cutoff = Date.now() - input.olderThanMs;
    let removed = 0;
    for (const container of await commandClient.listContainers(prefix)) {
      if (
        container.name.startsWith(prefix) &&
        container.createdAtMs !== undefined &&
        container.createdAtMs <= cutoff
      ) {
        await commandClient.removeContainer(container.name);
        removed += 1;
      }
    }
    return removed;
  }
}

export function createDockerRunInvocation(
  input: WorkspaceCommandProcessInput,
  options: Pick<
    DockerWorkspaceCommandProcessExecutorOptions,
    | "image"
    | "networkMode"
    | "readOnlyRootFilesystem"
    | "cpuCount"
    | "memoryBytes"
    | "pidsLimit"
    | "containerNamePrefix"
    | "createContainerName"
  >
): DockerRunInvocation {
  const containerName = sanitizeDockerName(
    options.createContainerName?.(input) ??
      `${options.containerNamePrefix ?? "catalyst-workspace-command"}-${input.command.id}-${randomUUID()}`
  );
  const environment = filterDockerSandboxEnvironment(input.env);
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    options.networkMode ?? "none",
    "--cpus",
    String(options.cpuCount ?? 1),
    "--memory",
    String(options.memoryBytes ?? DEFAULT_DOCKER_WORKSPACE_COMMAND_MEMORY_BYTES),
    "--pids-limit",
    String(options.pidsLimit ?? 128),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "none",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=64m",
    "--mount",
    `type=bind,source=${input.workspaceDirectory},target=/workspace`,
    "--workdir",
    containerWorkspaceCwd(input.workspaceCwd)
  ];
  if (options.readOnlyRootFilesystem ?? true) {
    args.push("--read-only");
  }
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(options.image, DEFAULT_WORKSPACE_COMMAND_SHELL, "-c", input.command.command);
  return {
    args,
    containerName,
    environment
  };
}

export function filterDockerSandboxEnvironment(
  env: Record<string, string>
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of SANDBOX_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return {
    ...filtered,
    PATH: DEFAULT_WORKSPACE_COMMAND_PATH,
    HOME: "/workspace",
    TMPDIR: "/tmp",
    WORKSPACE_DIR: "/workspace"
  };
}

class DockerCliCommandClient implements DockerCommandClient {
  constructor(private readonly options: { dockerPath: string; endpoint?: string }) {}

  /** Arguments that address the configured endpoint, before the Docker command itself. */
  private get endpointArgs(): string[] {
    return this.options.endpoint ? ["--host", this.options.endpoint] : [];
  }

  async run(input: DockerCommandRunInput): Promise<ProcessResult> {
    return runSpawnedProcess({
      executable: this.options.dockerPath,
      args: [...this.endpointArgs, ...input.args],
      timeoutSeconds: input.command.limits.timeoutSeconds,
      idleTimeoutSeconds: input.command.limits.idleTimeoutSeconds,
      maxStdoutBytes: input.command.limits.maxStdoutBytes,
      maxStderrBytes: input.command.limits.maxStderrBytes,
      signal: input.signal,
      onTerminate: () => this.removeContainer(input.containerName)
    });
  }

  async engineAnswers(signal: AbortSignal): Promise<boolean> {
    const result = await runSpawnedProcess({
      executable: this.options.dockerPath,
      args: [...this.endpointArgs, "version", "--format", "{{.Server.Version}}"],
      timeoutSeconds: ENGINE_CHECK_TIMEOUT_SECONDS,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      signal
    });
    return result.exitCode === 0 && !result.spawnError && !result.cancelled && !result.timeoutKind;
  }

  async listContainers(namePrefix: string): Promise<DockerContainerListing[]> {
    const result = await runSpawnedProcess({
      executable: this.options.dockerPath,
      args: [
        ...this.endpointArgs,
        "ps",
        "--all",
        "--filter",
        `name=^${namePrefix}`,
        "--format",
        "{{.Names}}\t{{.CreatedAt}}"
      ],
      timeoutSeconds: CONTAINER_LIST_TIMEOUT_SECONDS,
      maxStdoutBytes: CONTAINER_LIST_MAX_BYTES,
      maxStderrBytes: 1024
    });
    if (result.exitCode !== 0 || result.spawnError || result.timeoutKind) {
      return [];
    }
    return parseDockerContainerListing(result.stdoutPreview);
  }

  async removeContainer(name: string): Promise<void> {
    await runSpawnedProcess({
      executable: this.options.dockerPath,
      args: [...this.endpointArgs, "rm", "-f", name],
      timeoutSeconds: 10,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024
    });
  }
}

/** How long the engine may take to list containers. */
const CONTAINER_LIST_TIMEOUT_SECONDS = 10;
/** How much of the list is read: some thousand names. */
const CONTAINER_LIST_MAX_BYTES = 256 * 1024;

/**
 * Reads lines of `<name>\t<created>` as `docker ps` prints them, the time as
 * `2026-10-10 23:54:47 +0200 CEST`.
 */
export function parseDockerContainerListing(output: string): DockerContainerListing[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", created = ""] = line.split("\t");
      const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/u.exec(created);
      const createdAtMs = match
        ? Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`)
        : Number.NaN;
      return { name, ...(Number.isNaN(createdAtMs) ? {} : { createdAtMs }) };
    });
}

function containerWorkspaceCwd(workspaceCwd: string): string {
  if (workspaceCwd === ".") {
    return "/workspace";
  }
  return `/workspace/${workspaceCwd}`;
}

function sanitizeDockerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 128);
}
