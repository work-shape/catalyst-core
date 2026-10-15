import { createTestInstance } from "./support/test-instance";
import { inlineCommandResults } from "./support/workspace-command-jobs";
import { runnerContainer } from "./support/runner-container";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asToolCallId,
  asWorkspaceCommandId,
  type AgentRunId,
  type ClientInstanceId,
  type Conversation,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";

import {
  createDockerRunInvocation,
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandRunner,
  parseDockerContainerListing,
  resolveRunnerUser,
  RUNNER_GROUP_ID,
  RUNNER_USER_ID,
  WorkspaceCommandService,
  type DockerCommandClient,
  type DockerCommandRunInput,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessInput
} from "@work-shape/catalyst-tool-execution";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
  cleanupDirectories.length = 0;
});

describe("containers a killed worker left", () => {
  it("are read from the engine's list with the time they were made", () => {
    expect(
      parseDockerContainerListing(
        "catalyst-workspace-command-page-build-a\t2026-10-10 23:54:47 +0200 CEST\n" +
          "catalyst-workspace-command-page-build-b\tsome day\n\n"
      )
    ).toEqual([
      {
        name: "catalyst-workspace-command-page-build-a",
        createdAtMs: Date.parse("2026-10-10T21:54:47Z")
      },
      { name: "catalyst-workspace-command-page-build-b" }
    ]);
  });

  it("are removed by name when they are old enough, and only those of the asked commands", async () => {
    const minutesAgo = (minutes: number) => Date.now() - minutes * 60 * 1000;
    const removed: string[] = [];
    const asked: string[] = [];
    const executor = new DockerWorkspaceCommandProcessExecutor({
      image: "runner:test",
      commandClient: {
        run: () => Promise.reject(new Error("no command runs here")),
        removeContainer: async (name) => {
          removed.push(name);
        },
        listContainers: async (prefix) => {
          asked.push(prefix);
          return [
            { name: "catalyst-workspace-command-page-build-old", createdAtMs: minutesAgo(60) },
            // Another worker's build that still runs.
            { name: "catalyst-workspace-command-page-build-young", createdAtMs: minutesAgo(1) },
            // An engine that answered with something else is not trusted with a removal.
            { name: "catalyst-workspace-command-page-build-undated" },
            { name: "catalyst-workspace-command-wcmd_1", createdAtMs: minutesAgo(60) }
          ];
        }
      }
    });

    const count = await executor.removeLeftovers({
      idPrefix: "page-build-",
      olderThanMs: 15 * 60 * 1000
    });

    expect(asked).toEqual(["catalyst-workspace-command-page-build-"]);
    expect(removed).toEqual(["catalyst-workspace-command-page-build-old"]);
    expect(count).toBe(1);
  });
});

describe("docker workspace command runner", () => {
  it("builds sandboxed docker run arguments without inherited secrets or Docker socket mounts", () => {
    const invocation = createDockerRunInvocation(
      {
        command: {
          id: asWorkspaceCommandId("wcmd_docker_args"),
          command: "node build.js",
          limits: { timeoutSeconds: 60 }
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
        "/bin/bash",
        "-c",
        "node build.js"
      ])
    );
    const serializedArgs = invocation.args.join("\n");
    expect(serializedArgs).not.toContain("target=/workspace,rw");
    expect(serializedArgs).not.toMatch(
      /DATABASE_URL|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|DOCKER_HOST/u
    );
    expect(serializedArgs).not.toContain("/var/run/docker.sock");
  });

  it("names a user on every docker run, and never root", () => {
    const userOf = (worker?: { uid?: number; gid?: number }) => {
      const args = createDockerRunInvocation(dockerProcessInput(), {
        image: "runner:test",
        ...(worker ? { runnerUser: resolveRunnerUser(worker) } : {})
      }).args;
      return {
        user: args[args.indexOf("--user") + 1],
        tmpfs: args.filter((_, index) => args[index - 1] === "--tmpfs"),
        // The user is an option of `docker run`, so it stands before the image.
        beforeImage: args.indexOf("--user") < args.indexOf("runner:test")
      };
    };

    // The worker of a deployment is root in its container.
    expect(userOf({ uid: 0, gid: 0 })).toEqual({
      user: `${RUNNER_USER_ID}:${RUNNER_GROUP_ID}`,
      tmpfs: [
        `/tmp:rw,nosuid,nodev,size=64m,uid=${RUNNER_USER_ID},gid=${RUNNER_GROUP_ID}`,
        `/var/tmp:rw,nosuid,nodev,size=64m,uid=${RUNNER_USER_ID},gid=${RUNNER_GROUP_ID}`
      ],
      beforeImage: true
    });
    expect(RUNNER_USER_ID).toBe(10001);
    expect(resolveRunnerUser({ uid: 0, gid: 0 }).receivesWorkspace).toBe(true);
    // A developer's worker runs commands as itself and gives nothing away.
    expect(userOf({ uid: 501, gid: 20 }).user).toBe("501:20");
    expect(resolveRunnerUser({ uid: 501, gid: 20 }).receivesWorkspace).toBe(false);
    // Neither the group of root nor a platform without user ids ends as root.
    expect(userOf({ uid: 501, gid: 0 }).user).toBe(`501:${RUNNER_GROUP_ID}`);
    expect(userOf({}).user).toBe(`${RUNNER_USER_ID}:${RUNNER_GROUP_ID}`);
    // Without a named user the invocation resolves one itself.
    expect(userOf().user).toMatch(/^[1-9]\d*:[1-9]\d*$/u);

    for (const root of [
      { uid: 0, gid: 0, receivesWorkspace: false },
      { uid: 0, gid: RUNNER_GROUP_ID, receivesWorkspace: true },
      { uid: RUNNER_USER_ID, gid: 0, receivesWorkspace: true }
    ]) {
      expect(() =>
        createDockerRunInvocation(dockerProcessInput(), { image: "runner:test", runnerUser: root })
      ).toThrow("never runs as root");
      expect(
        () => new DockerWorkspaceCommandProcessExecutor({ image: "runner:test", runnerUser: root })
      ).toThrow("never runs as root");
    }
  });

  it("gives the workspace to the runner's user before the command, or does not start it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "catalyst-runner-user-test-"));
    cleanupDirectories.push(directory);
    await mkdir(join(directory, "reports"));
    await writeFile(join(directory, "reports", "input.txt"), "filled by the worker");
    // A link a command left must not lead the worker to a file outside the workspace.
    const outside = join(await mkdtemp(join(tmpdir(), "catalyst-runner-outside-")), "kept.txt");
    cleanupDirectories.push(join(outside, ".."));
    await writeFile(outside, "not the command's");
    await symlink(outside, join(directory, "link"));
    const fakeDocker = new FakeDockerCommandClient(async () => processResult({ exitCode: 0 }));
    const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const execute = (runnerUser: { uid: number; gid: number; receivesWorkspace: boolean }) =>
      new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: fakeDocker,
        runnerUser
      }).execute(dockerProcessInput({ workspaceDirectory: directory, cwd: directory }));

    const result = await execute({
      uid: RUNNER_USER_ID,
      gid: RUNNER_GROUP_ID,
      receivesWorkspace: true
    });

    if (self.uid === 0) {
      // A worker that is root: the files are the runner's before the command starts.
      expect(result.spawnError).toBeUndefined();
      expect(fakeDocker.runs).toHaveLength(1);
      for (const path of ["", "reports", "reports/input.txt", "link"]) {
        expect((await lstat(join(directory, path))).uid).toBe(RUNNER_USER_ID);
      }
      expect((await lstat(outside)).uid).toBe(0);
    } else {
      // A worker that cannot give the files away does not run the command as someone else.
      expect(result.spawnError?.message).toContain(
        `could not be given to the runner's user ${RUNNER_USER_ID}:${RUNNER_GROUP_ID}`
      );
      expect(fakeDocker.runs).toHaveLength(0);
    }
  });

  it("creates the runner's user in the image of the platform", async () => {
    const dockerfile = await readFile(
      new URL("../docker/vivd-client.Dockerfile", import.meta.url),
      "utf8"
    );
    const runner = dockerfile.slice(dockerfile.indexOf(" AS workspace-command-runner"));
    const stage = runner.slice(0, runner.indexOf("\nFROM "));
    expect(stage).toContain(`groupadd --gid ${RUNNER_GROUP_ID} catalyst-runner`);
    expect(stage).toContain(
      `useradd --uid ${RUNNER_USER_ID} --gid ${RUNNER_GROUP_ID} --home-dir /workspace`
    );
    expect(stage).toContain("ENV HOME=/workspace");
    expect(stage.split("\n").filter((line) => line.startsWith("USER "))).toEqual([
      `USER ${RUNNER_USER_ID}:${RUNNER_GROUP_ID}`
    ]);
  });

  it("defaults Docker runner containers to a 4 GiB memory limit", () => {
    const invocation = createDockerRunInvocation(dockerProcessInput(), {
      image: "runner:test"
    });

    const memoryArgIndex = invocation.args.indexOf("--memory");
    expect(invocation.args[memoryArgIndex + 1]).toBe(String(4 * 1024 * 1024 * 1024));
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
    const command = await harness.store.executionWorkspaces.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: asWorkspaceCommandId(result.output!.commandId)
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
    controller.abort("Workspace command worker is stopping");

    await expect(running).resolves.toMatchObject({
      cancelled: true,
      cancellationReason: "Workspace command worker is stopping"
    });
    expect(fakeDocker.removedContainers).toEqual(["fake-container"]);
  });
});

// The same with a Docker engine and the runner image of a release. It runs only where an image
// is named, and must run once on Linux as root, which is what the worker of a deployment is:
// CATALYST_RUNNER_IMAGE=<image> pnpm exec vitest run tests/docker-workspace-command-runner.test.ts
const runnerImage = process.env.CATALYST_RUNNER_IMAGE;

describe.skipIf(!runnerImage)("a command in the runner image", () => {
  it("is not root, writes where a command may, and leaves files the worker reads and removes", async () => {
    const container = runnerContainer(runnerImage ?? "");
    const harness = await createDockerHarness({ executor: container.executor });
    const expected = container.user;

    const result = await harness.exec(
      [
        "set -eu",
        'echo "uid=$(id -u) gid=$(id -g) home=$HOME"',
        // Capabilities of the process: none effective, none it could gain.
        "grep -E '^Cap(Eff|Prm|Bnd):' /proc/self/status | tr -s '\\t\\n' ' '",
        "mkdir -p reports && id -u > reports/who.txt",
        'touch "$HOME/.profile-probe" /tmp/probe /var/tmp/probe',
        "if touch /usr/local/bin/probe 2>/dev/null; then echo root-filesystem-writable; fi"
      ].join("\n")
    );

    if (result.status !== "success" || !result.output) {
      throw new Error(`The command did not run: ${JSON.stringify(result)}`);
    }
    expect(result.output).toMatchObject({ status: "completed", exitCode: 0 });
    const stdout = result.output.stdoutPreview;
    expect(stdout).toContain(`uid=${expected.uid} gid=${expected.gid} home=/workspace`);
    expect(stdout).not.toContain("uid=0 ");
    expect(stdout).toContain("CapEff: 0000000000000000");
    expect(stdout).toContain("CapBnd: 0000000000000000");
    expect(stdout).not.toContain("root-filesystem-writable");
    // The worker read what the command wrote.
    const file = await harness.service.readFile({ path: "reports/who.txt" }, harness.context);
    if (file.status !== "success") {
      throw new Error(`The worker did not read the file: ${JSON.stringify(file)}`);
    }
    expect(file.output?.contentPreview?.trim()).toBe(String(expected.uid));
    // And removed it: nothing of the command is left under the worker's directory.
    expect(await readdir(harness.commandsDirectory)).toEqual([]);
  }, 120_000);
});

async function createDockerHarness(input: {
  fakeResult?: (input: DockerCommandRunInput) => Promise<ProcessResult>;
  executor?: WorkspaceCommandProcessExecutor;
}) {
  const clientInstanceId = asClientInstanceId(`docker_runner_${globalThis.crypto.randomUUID()}`);
  const ownerUserId = "user-1";
  const store = (await createTestInstance()).stores;
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: ownerUserId,
    createdByExternalUserId: ownerUserId,
    title: "Docker workspace runner test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const rootDirectory = await mkdtemp(join(tmpdir(), "catalyst-docker-runner-test-"));
  cleanupDirectories.push(rootDirectory);
  const byteStore = createFilesystemObjectStorage(join(rootDirectory, "objects"));
  const fakeDocker = new FakeDockerCommandClient(
    input.fakeResult ?? (() => Promise.reject(new Error("no fake result was given")))
  );
  const commandsDirectory = join(rootDirectory, "commands");
  const runner = new LocalWorkspaceCommandRunner({
    store,
    byteStore,
    tempRootDirectory: commandsDirectory,
    processExecutor:
      input.executor ??
      new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: fakeDocker,
        createContainerName: () => "fake-container"
      })
  });
  const service = new WorkspaceCommandService({
    store,
    objectStore: byteStore,
    commandResults: inlineCommandResults(store, { runner })
  });
  const context = createToolContext(
    clientInstanceId,
    conversation,

    (await store.createAgentRunForTesting(conversation)).id
  );
  return {
    clientInstanceId,
    store,
    service,
    context,
    fakeDocker,
    commandsDirectory,
    async exec(command: string) {
      return service.exec({ command }, context);
    }
  };
}

class FakeDockerCommandClient implements DockerCommandClient {
  readonly runs: DockerCommandRunInput[] = [];
  readonly removedContainers: string[] = [];

  constructor(
    private readonly fakeResult: (input: DockerCommandRunInput) => Promise<ProcessResult>
  ) {}

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
      command: "sleep 600",
      limits: { timeoutSeconds: 60 }
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
  conversation: Conversation,
  agentRunId: AgentRunId
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
      agentRunId,
      conversationId: conversation.id,
      agentName: "workspace_agent",
      input: {}
    }
  };
}
