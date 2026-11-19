import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LocalWorkspaceCommandProcessExecutor,
  type SandboxRequestChannel
} from "@work-shape/catalyst-tool-execution";

// The request channel of a command (TOOL-2c) is bounded apart from its output: a command that
// writes requests faster than they are answered, or more or longer ones than it may make, holds
// no memory of the worker for it, and requests never put its idle timeout off.

const MARK = "end-of-requests";
let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "request-channel-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function channel(overrides: Partial<SandboxRequestChannel> = {}) {
  const asked: string[] = [];
  const requests: SandboxRequestChannel = {
    endMark: MARK,
    maxLineBytes: 1_024,
    maxLines: 5,
    answer: (line) => {
      asked.push(line);
      return Promise.resolve(`answer ${String(asked.length)}`);
    },
    refuse: () => "too long",
    ...overrides
  };
  return { requests, asked };
}

function run(
  script: string,
  requests: SandboxRequestChannel,
  limits: { timeoutSeconds?: number; idleTimeoutSeconds?: number; maxStdoutBytes?: number } = {}
) {
  return new LocalWorkspaceCommandProcessExecutor().execute({
    command: {
      id: "request-channel",
      command: script,
      limits: {
        timeoutSeconds: limits.timeoutSeconds ?? 20,
        idleTimeoutSeconds: limits.idleTimeoutSeconds ?? 20,
        maxStdoutBytes: limits.maxStdoutBytes ?? 64 * 1_024,
        maxStderrBytes: 1_024
      }
    },
    requests,
    workspaceDirectory: directory,
    workspaceCwd: ".",
    cwd: directory,
    tempDirectory: join(directory, "tmp"),
    env: { PATH: "/usr/bin:/bin" }
  });
}

describe("a command's request channel", () => {
  it("answers its requests in order, then hands on what follows the mark as output", async () => {
    const { requests, asked } = channel();
    const result = await run(
      `echo one; read a; echo two; read b; echo ${MARK}; echo "$a / $b"`,
      requests
    );
    expect(asked).toEqual(["one", "two"]);
    expect(result.stdoutPreview.trim()).toBe("answer 1 / answer 2");
  });

  it("answers no more than its lines and closes the command's input past them", async () => {
    const { requests, asked } = channel();
    // A command that writes requests without end and reads no answers.
    const result = await run(
      `i=0; while [ $i -lt 2000 ]; do echo "request $i"; i=$((i+1)); done; echo ${MARK}; echo done`,
      requests
    );
    expect(asked.length).toBe(5);
    expect(result.stdoutPreview.trim()).toBe("done");
  });

  it("answers requests within its own bounds however much smaller the output's bound is", async () => {
    const { requests, asked } = channel({ maxLines: 5 });
    const line = "x".repeat(400);
    const result = await run(
      `for i in 1 2 3 4 5; do echo ${line}; read answer; done; echo ${MARK}; echo done`,
      requests,
      { maxStdoutBytes: 1_000 }
    );
    expect(asked.length).toBe(5);
    expect(result.stdoutPreview.trim()).toBe("done");
    expect(result.truncated.stdout).toBe(false);
  });

  it("closes once its requests pass its lines of the longest request", async () => {
    let refused = 0;
    // Lines longer than a request may be: each is one line, but its bytes are counted.
    const { requests } = channel({
      maxLines: 50,
      maxLineBytes: 100,
      refuse: () => {
        refused += 1;
        return "too long";
      }
    });
    const line = "x".repeat(4_000);
    const result = await run(
      `for i in 1 2 3 4 5 6; do echo ${line}; read answer || break; done; echo ${MARK}; echo done`,
      requests
    );
    expect(refused).toBeLessThanOrEqual(2);
    expect(result.stdoutPreview.trim()).toBe("done");
  });

  it("is idle while it only writes requests nobody answers any more", async () => {
    const { requests } = channel({ maxLines: 2 });
    const result = await run(`while true; do echo again; sleep 0.2; done`, requests, {
      timeoutSeconds: 15,
      idleTimeoutSeconds: 1
    });
    expect(result.timeoutKind).toBe("idle");
    expect(result.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it("does not count the wait for an answer as idle", async () => {
    const { requests, asked } = channel({
      answer: async (line) => {
        asked.push(line);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return "late";
      }
    });
    const result = await run(`echo slow; read a; echo ${MARK}; echo "$a"`, requests, {
      idleTimeoutSeconds: 1
    });
    expect(result.timeoutKind).toBeUndefined();
    expect(result.stdoutPreview.trim()).toBe("late");
  }, 20_000);
});
