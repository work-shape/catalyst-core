import { randomUUID } from "node:crypto";
import type { ExecutionWorkspaceRunnerConfig } from "@vivd-catalyst/core";
import {
  DEFAULT_WORKSPACE_COMMAND_PATH,
  runSpawnedProcess,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessInput
} from "./workspace-command-executor";

const SANDBOX_ENV_KEYS = new Set(["HOME", "PATH", "TMPDIR", "WORKSPACE_DIR"]);

export interface DockerWorkspaceCommandProcessExecutorOptions {
  image: string;
  dockerPath?: string;
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
      memoryBytes: options.memoryBytes ?? 512 * 1024 * 1024,
      pidsLimit: options.pidsLimit ?? 128,
      containerNamePrefix: options.containerNamePrefix ?? "catalyst-workspace-command",
      commandClient:
        options.commandClient ??
        new DockerCliCommandClient({
          dockerPath: options.dockerPath ?? "docker"
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
}

export function createDockerProcessExecutorFromConfig(
  config: ExecutionWorkspaceRunnerConfig
): DockerWorkspaceCommandProcessExecutor {
  return new DockerWorkspaceCommandProcessExecutor({
    image: config.image,
    networkMode: config.networkMode,
    readOnlyRootFilesystem: config.readOnlyRootFilesystem,
    cpuCount: config.cpuCount,
    memoryBytes: config.memoryBytes,
    pidsLimit: config.pidsLimit
  });
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
    String(options.memoryBytes ?? 512 * 1024 * 1024),
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
    `type=bind,source=${input.workspaceDirectory},target=/workspace,rw`,
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
  args.push(options.image, "/bin/sh", "-lc", input.command.command);
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
  constructor(private readonly options: { dockerPath: string }) {}

  async run(input: DockerCommandRunInput): Promise<ProcessResult> {
    return runSpawnedProcess({
      executable: this.options.dockerPath,
      args: input.args,
      timeoutSeconds: input.command.limits.timeoutSeconds,
      idleTimeoutSeconds: input.command.limits.idleTimeoutSeconds,
      maxStdoutBytes: input.command.limits.maxStdoutBytes,
      maxStderrBytes: input.command.limits.maxStderrBytes,
      signal: input.signal,
      onTerminate: () => this.removeContainer(input.containerName)
    });
  }

  async removeContainer(name: string): Promise<void> {
    await runSpawnedProcess({
      executable: this.options.dockerPath,
      args: ["rm", "-f", name],
      timeoutSeconds: 10,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024
    });
  }
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
