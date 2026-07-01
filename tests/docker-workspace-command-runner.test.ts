import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asExecutionWorkspaceId,
  asToolCallId,
  asWorkspaceCommandId,
  type ClientInstanceId,
  type Conversation,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createDockerRunInvocation,
  createLocalWorkspaceFileByteStore,
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandResultSource,
  LocalWorkspaceCommandRunner,
  WorkspaceCommandService,
  type DockerCommandClient,
  type DockerCommandRunInput,
  type ProcessResult,
  type WorkspaceCommandProcessInput
} from "@vivd-catalyst/tool-execution";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  cleanupDirectories.length = 0;
});

describe("docker workspace command runner", () => {
  it("builds sandboxed docker run arguments without inherited secrets or Docker socket mounts", () => {
    const invocation = createDockerRunInvocation(
      {
        command: {
          id: asWorkspaceCommandId("wcmd_docker_args"),
          workspaceId: asExecutionWorkspaceId("ews_docker_args"),
          clientInstanceId: asClientInstanceId("client_docker_args"),
          conversationId: asConversationId("conv_docker_args"),
          ownerUserId: "user-1",
          command: "node build.js",
          status: "running",
          limits: { timeoutSeconds: 60 },
          expectedOutputs: [],
          attempts: 1,
          queuedAt: "2026-06-29T10:00:00.000Z",
          updatedAt: "2026-06-29T10:00:00.000Z"
        },
        workspaceDirectory: "/host/workspace",
        workspaceCwd: "reports",
        cwd: "/host/workspace/reports",
        tempDirectory: "/host/tmp",
        env: {
          DATABASE_URL: "postgres://secret",
          OPENAI_API_KEY: "secret",
          AWS_SECRET_ACCESS_KEY: "secret",
          DOCKER_HOST: "unix:///var/run/docker.sock",
          HOME: "/internal/home",
          PATH: "/unsafe/bin",
          TMPDIR: "/internal/tmp",
          WORKSPACE_DIR: "/internal/workspace"
        }
      },
      {
        image: "runner:test",
        networkMode: "none",
        readOnlyRootFilesystem: true,
        cpuCount: 0.5,
        memoryBytes: 256 * 1024 * 1024,
        pidsLimit: 64,
        containerNamePrefix: "test",
        createContainerName: () => "test-container"
      }
    );

    expect(invocation.environment).toEqual({
      HOME: "/workspace",
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: "/tmp",
      WORKSPACE_DIR: "/workspace"
    });
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        "type=bind,source=/host/workspace,target=/workspace",
        "--workdir",
        "/workspace/reports",
        "runner:test",
        "/bin/sh",
        "-lc",
        "node build.js"
      ])
    );
    const serializedArgs = invocation.args.join("\n");
    expect(serializedArgs).not.toContain("target=/workspace,rw");
    expect(serializedArgs).not.toMatch(/DATABASE_URL|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|DOCKER_HOST/u);
    expect(serializedArgs).not.toContain("/var/run/docker.sock");
  });

  it("defaults Docker runner containers to a 2 GiB memory limit", () => {
    const invocation = createDockerRunInvocation(dockerProcessInput(), {
      image: "runner:test"
    });

    const memoryArgIndex = invocation.args.indexOf("--memory");
    expect(invocation.args[memoryArgIndex + 1]).toBe(String(2 * 1024 * 1024 * 1024));
  });

  it("hands execution to Docker, captures output, and syncs files through the normal workspace lifecycle", async () => {
    const harness = await createDockerHarness({
      fakeResult: async (input) => {
        const workspaceDirectory = dockerWorkspaceSource(input.args);
        await writeFile(join(workspaceDirectory, "docker-output.txt"), "from docker", "utf8");
        return processResult({
          exitCode: 0,
          stdoutPreview: "created"
        });
      }
    });

    const result = await harness.exec("printf 'ignored by fake docker'");

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected docker-backed command result");
    }
    expect(harness.fakeDocker.runs).toHaveLength(1);
    expect(result.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdoutPreview: "created",
      changedFiles: [expect.objectContaining({ path: "docker-output.txt", byteSize: 11 })]
    });
    const file = await harness.service.readFile({ path: "docker-output.txt" }, harness.context);
    expect(file.status).toBe("success");
    if (file.status !== "success") {
      throw new Error("Expected synced file to be readable");
    }
    expect(file.output?.contentPreview).toBe("from docker");
  });

  it("maps Docker timeout results to failed workspace commands and removes timed-out containers", async () => {
    const harness = await createDockerHarness({
      fakeResult: async () =>
        processResult({
          exitCode: 124,
          stderrPreview: "timed out",
          timeoutKind: "wall"
        })
    });

    const result = await harness.exec("sleep 600");

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected timeout command result");
    }
    expect(result.output).toMatchObject({
      status: "failed",
      exitCode: 124,
      stderrPreview: "timed out"
    });
    const command = await harness.store.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: result.output!.commandId
    });
    expect(command?.error).toMatchObject({
      code: "WORKSPACE_COMMAND_TIMEOUT",
      category: "timeout"
    });
    expect(harness.fakeDocker.removedContainers).toEqual(["fake-container"]);
  });

  it("removes cancelled Docker containers when active execution is aborted", async () => {
    const controller = new AbortController();
    const fakeDocker = new FakeDockerCommandClient(
      (input) =>
        new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () =>
              resolve(
                processResult({
                  exitCode: 130,
                  cancelled: true,
                  cancellationReason:
                    typeof input.signal?.reason === "string" ? input.signal.reason : undefined
                })
              ),
            { once: true }
          );
        })
    );
    const executor = new DockerWorkspaceCommandProcessExecutor({
      image: "runner:test",
      commandClient: fakeDocker,
      createContainerName: () => "fake-container"
    });

    const running = executor.execute(
      dockerProcessInput({
        signal: controller.signal
      })
    );
    controller.abort("Received SIGTERM");

    await expect(running).resolves.toMatchObject({
      cancelled: true,
      cancellationReason: "Received SIGTERM"
    });
    expect(fakeDocker.removedContainers).toEqual(["fake-container"]);
  });
});

async function createDockerHarness(input: {
  fakeResult: (input: DockerCommandRunInput) => Promise<ProcessResult>;
}) {
  const clientInstanceId = asClientInstanceId(`docker_runner_${globalThis.crypto.randomUUID()}`);
  const ownerUserId = "user-1";
  const store = new InMemoryPlatformStore();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId,
    ownerExternalUserId: ownerUserId,
    title: "Docker workspace runner test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const rootDirectory = await mkdtemp(join(tmpdir(), "catalyst-docker-runner-test-"));
  cleanupDirectories.push(rootDirectory);
  const byteStore = createLocalWorkspaceFileByteStore({
    rootDirectory: join(rootDirectory, "objects")
  });
  const fakeDocker = new FakeDockerCommandClient(input.fakeResult);
  const runner = new LocalWorkspaceCommandRunner({
    store,
    byteStore,
    tempRootDirectory: join(rootDirectory, "commands"),
    processExecutor: new DockerWorkspaceCommandProcessExecutor({
      image: "runner:test",
      commandClient: fakeDocker,
      createContainerName: () => "fake-container"
    })
  });
  const service = new WorkspaceCommandService({
    store,
    objectStore: byteStore,
    commandResults: new LocalWorkspaceCommandResultSource(runner)
  });
  const context = createToolContext(clientInstanceId, conversation);
  return {
    clientInstanceId,
    store,
    service,
    context,
    fakeDocker,
    async exec(command: string) {
      return service.exec({ command }, context);
    }
  };
}

class FakeDockerCommandClient implements DockerCommandClient {
  readonly runs: DockerCommandRunInput[] = [];
  readonly removedContainers: string[] = [];

  constructor(private readonly fakeResult: (input: DockerCommandRunInput) => Promise<ProcessResult>) {}

  async run(input: DockerCommandRunInput): Promise<ProcessResult> {
    this.runs.push(input);
    return this.fakeResult(input);
  }

  async removeContainer(name: string): Promise<void> {
    this.removedContainers.push(name);
  }
}

function dockerWorkspaceSource(args: string[]): string {
  const mount = args[args.indexOf("--mount") + 1];
  if (!mount) {
    throw new Error("Docker invocation did not include a workspace mount");
  }
  const source = mount
    .split(",")
    .find((part) => part.startsWith("source="))
    ?.slice("source=".length);
  if (!source) {
    throw new Error("Docker workspace mount source was missing");
  }
  return source;
}

function processResult(input: Partial<ProcessResult> & { exitCode: number }): ProcessResult {
  return {
    stdoutPreview: "",
    stderrPreview: "",
    durationMs: 25,
    truncated: {
      stdout: false,
      stderr: false
    },
    ...input
  };
}

function dockerProcessInput(
  input: Partial<WorkspaceCommandProcessInput> = {}
): WorkspaceCommandProcessInput {
  return {
    command: {
      id: asWorkspaceCommandId("wcmd_docker_cancel"),
      workspaceId: asExecutionWorkspaceId("ews_docker_cancel"),
      clientInstanceId: asClientInstanceId("client_docker_cancel"),
      conversationId: asConversationId("conv_docker_cancel"),
      ownerUserId: "user-1",
      command: "sleep 600",
      status: "running",
      limits: { timeoutSeconds: 60 },
      expectedOutputs: [],
      attempts: 1,
      queuedAt: "2026-06-29T10:00:00.000Z",
      updatedAt: "2026-06-29T10:00:00.000Z"
    },
    workspaceDirectory: "/host/workspace",
    workspaceCwd: ".",
    cwd: "/host/workspace",
    tempDirectory: "/host/tmp",
    env: {},
    ...input
  };
}

function createToolContext(
  clientInstanceId: ClientInstanceId,
  conversation: Conversation
): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_docker_runner",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "Docker Runner User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    },
    toolRequest: {
      toolName: "workspace.exec",
      toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
      agentRunId: asAgentRunId(`run_${globalThis.crypto.randomUUID()}`),
      conversationId: conversation.id,
      agentName: "workspace_agent",
      input: {}
    }
  };
}
