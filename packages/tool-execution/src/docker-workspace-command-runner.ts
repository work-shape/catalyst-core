import { randomUUID } from "node:crypto";
import { lchown, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_COMMAND_SHELL,
  DEFAULT_WORKSPACE_COMMAND_PATH,
  SANDBOX_DATA_DIRECTORIES,
  SANDBOX_SOURCE_DIRECTORY,
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

/**
 * The user and the group a command has in the runner container when the worker is root, which
 * it is in its own container. Both runner images create this user. It is fixed and is not a
 * setting: an operator who must know which user owns the files of a command reads it here.
 */
export const RUNNER_USER_ID = 10001;
export const RUNNER_GROUP_ID = 10001;

/** Who a command is in the runner container. Never root. */
export interface RunnerUser {
  uid: number;
  gid: number;
  /**
   * Whether the worker gives the workspace directory to this user before the command starts.
   * Only a worker that is root can, and only it has to: any other worker runs the command as
   * itself.
   */
  receivesWorkspace: boolean;
}

/**
 * The user of every command in the runner container. A worker that is root runs commands as
 * `RUNNER_USER_ID`. A worker that is not root, on a developer's machine, cannot give files
 * away, so the command runs as the worker's own user and the files stay its own. A platform
 * without user ids runs commands as `RUNNER_USER_ID` too. No case answers root.
 */
export function resolveRunnerUser(
  worker: { uid?: number; gid?: number } = {
    uid: process.getuid?.(),
    gid: process.getgid?.()
  }
): RunnerUser {
  if (worker.uid === undefined || worker.uid === 0) {
    return { uid: RUNNER_USER_ID, gid: RUNNER_GROUP_ID, receivesWorkspace: worker.uid === 0 };
  }
  return {
    uid: worker.uid,
    // A worker in the group of root keeps its user and gets the runner's group.
    gid: worker.gid === undefined || worker.gid === 0 ? RUNNER_GROUP_ID : worker.gid,
    receivesWorkspace: false
  };
}

/**
 * Gives a directory and everything in it to a user. A link is given away itself and is never
 * followed, so a link a command left cannot name a file outside the directory.
 */
async function giveDirectoryTo(directory: string, user: RunnerUser): Promise<void> {
  await lchown(directory, user.uid, user.gid);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await giveDirectoryTo(path, user);
    } else {
      await lchown(path, user.uid, user.gid);
    }
  }
}

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
  /** Who commands are in the container. Absent means `resolveRunnerUser()`. Root is refused. */
  runnerUser?: RunnerUser;
}

export interface DockerCommandClient {
  run(input: DockerCommandRunInput): Promise<ProcessResult>;
  removeContainer?(name: string): Promise<void>;
  /**
   * Whether the engine ended a process of this container for its memory, as the engine itself
   * recorded it. Nothing where the engine cannot be asked or the container is gone.
   */
  wasOutOfMemory?(name: string): Promise<boolean | undefined>;
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
  readonly dataPaths = SANDBOX_DATA_DIRECTORIES;
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
    runnerUser: RunnerUser;
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
      createContainerName: options.createContainerName,
      runnerUser: options.runnerUser ?? resolveRunnerUser()
    };
    assertNotRoot(this.options.runnerUser);
  }

  /**
   * The one place a command starts: workspace commands and the Page build both come through
   * here, so both run as the runner's user.
   */
  async execute(input: WorkspaceCommandProcessInput): Promise<ProcessResult> {
    const invocation = createDockerRunInvocation(input, this.options);
    if (this.options.runnerUser.receivesWorkspace) {
      const startedAt = Date.now();
      try {
        // The worker filled the directory as root. The command must be able to write there.
        await giveDirectoryTo(input.workspaceDirectory, this.options.runnerUser);
        // The output directory is empty, and the command writes it. Its input stays root's.
        if (input.sandboxLimits && input.dataDirectories) {
          await lchown(
            input.dataDirectories.output,
            this.options.runnerUser.uid,
            this.options.runnerUser.gid
          );
        }
      } catch (error) {
        // The command does not start as root instead.
        return {
          exitCode: 1,
          stdoutPreview: "",
          stderrPreview: "",
          truncated: { stdout: false, stderr: false },
          durationMs: Date.now() - startedAt,
          spawnError: new Error(
            `The workspace directory could not be given to the runner's user ${this.options.runnerUser.uid}:${this.options.runnerUser.gid}: ${error instanceof Error ? error.message : String(error)}`
          )
        };
      }
    }
    const result = await this.options.commandClient.run({
      args: invocation.args,
      containerName: invocation.containerName,
      command: input.command,
      signal: input.signal
    });
    if (!input.sandboxLimits) {
      if (result.cancelled || result.timeoutKind) {
        await this.options.commandClient.removeContainer?.(invocation.containerName);
      }
      return result;
    }
    // A command with limits of its own keeps its container when it ends, so that the engine
    // can be asked how it ended. An exit code of 137 is what a script may exit with itself.
    const ended = !result.cancelled && !result.timeoutKind && !result.spawnError;
    const outOfMemory = ended
      ? await this.options.commandClient.wasOutOfMemory?.(invocation.containerName)
      : undefined;
    await this.options.commandClient.removeContainer?.(invocation.containerName);
    return { ...result, ...(outOfMemory === undefined ? {} : { outOfMemory }) };
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
    | "runnerUser"
  >
): DockerRunInvocation {
  const user = options.runnerUser ?? resolveRunnerUser();
  assertNotRoot(user);
  const containerName = sanitizeDockerName(
    options.createContainerName?.(input) ??
      `${options.containerNamePrefix ?? "catalyst-workspace-command"}-${input.command.id}-${randomUUID()}`
  );
  const environment = filterDockerSandboxEnvironment(input.env);
  const own = input.sandboxLimits;
  const scratch = own?.scratchBytes;
  const args = [
    "run",
    // The container of a command with limits of its own is removed by its worker, after the
    // engine was asked how it ended.
    ...(own ? [] : ["--rm"]),
    "--name",
    containerName,
    "--network",
    options.networkMode ?? "none",
    "--cpus",
    String(own?.cpuCount ?? options.cpuCount ?? 1),
    "--memory",
    String(
      own?.memoryBytes ?? options.memoryBytes ?? DEFAULT_DOCKER_WORKSPACE_COMMAND_MEMORY_BYTES
    ),
    // A command with limits of its own gets no swap beyond its memory, so a script that
    // allocates without end is ended at the limit and not after the host swapped for it.
    ...(own ? ["--memory-swap", String(own.memoryBytes)] : []),
    "--pids-limit",
    String(own?.pidsLimit ?? options.pidsLimit ?? 128),
    "--user",
    `${user.uid}:${user.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "none",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=64m,uid=${user.uid},gid=${user.gid}`,
    "--tmpfs",
    `/var/tmp:rw,nosuid,nodev,size=64m,uid=${user.uid},gid=${user.gid}`,
    ...(scratch === undefined
      ? ["--mount", `type=bind,source=${input.workspaceDirectory},target=/workspace`]
      : [
          // Nothing the command writes reaches the worker's disk: what the worker filled is
          // read-only, and the working directory is memory of a stated size.
          "--mount",
          `type=bind,source=${input.workspaceDirectory},target=${SANDBOX_SOURCE_DIRECTORY},readonly`,
          "--tmpfs",
          `/workspace:rw,nosuid,nodev,size=${String(scratch)},uid=${user.uid},gid=${user.gid}`
        ]),
    // Only a command with limits of its own is handed data directories: what its worker wrote
    // for it, read-only, and one directory on the worker's disk that it writes. The worker
    // bounds what is written there and reads it back without following a link.
    ...(own && input.dataDirectories
      ? [
          "--mount",
          `type=bind,source=${input.dataDirectories.input},target=${SANDBOX_DATA_DIRECTORIES.input},readonly`,
          "--mount",
          `type=bind,source=${input.dataDirectories.output},target=${SANDBOX_DATA_DIRECTORIES.output}`
        ]
      : []),
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

  async wasOutOfMemory(name: string): Promise<boolean | undefined> {
    const result = await runSpawnedProcess({
      executable: this.options.dockerPath,
      args: [...this.endpointArgs, "inspect", "--format", "{{.State.OOMKilled}}", name],
      timeoutSeconds: 10,
      maxStdoutBytes: 64,
      maxStderrBytes: 1024
    });
    if (result.exitCode !== 0 || result.spawnError || result.timeoutKind) return undefined;
    const answer = result.stdoutPreview.trim();
    return answer === "true" ? true : answer === "false" ? false : undefined;
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

function assertNotRoot(user: RunnerUser): void {
  if (
    !Number.isInteger(user.uid) ||
    !Number.isInteger(user.gid) ||
    user.uid <= 0 ||
    user.gid <= 0
  ) {
    throw new Error("A command in the runner container never runs as root.");
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
