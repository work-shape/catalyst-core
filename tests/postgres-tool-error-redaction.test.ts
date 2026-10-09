import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, asWorkspaceCommandId, type Logger } from "@vivd-catalyst/core";
import { InProcessToolExecution, ToolRegistry } from "@vivd-catalyst/tool-execution";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import { usePostgresSuite } from "./support/postgres-suite";
import { createWorkspaceHarnessOn } from "./support/workspace-tools-harness";

const marker = "PRIVATE_PARAMETER_VALUE";

describe("tool handler error boundary on Postgres", () => {
  const suite = usePostgresSuite("tool_redaction");

  it("keeps a driver error out of the tool result and hands it to the logger", async () => {
    const harness = await createWorkspaceHarnessOn(suite.store, suite.clientInstance("driver"));
    const workspace = await suite.store.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      ownerUserId: harness.ownerUserId
    });
    const logged: Array<{ input: unknown; message?: string }> = [];
    const execution = executionFor(
      defineTool({
        name: "test.write",
        description: "Writes a row that breaks a foreign key.",
        inputSchema: z.object({}),
        async execute() {
          await suite.store.executionWorkspaces.upsertWorkspaceFile({
            clientInstanceId: harness.clientInstanceId,
            workspaceId: workspace.id,
            path: "notes.txt",
            objectKey: marker,
            byteSize: 1,
            checksum: "sha256:notes",
            lastCommandId: asWorkspaceCommandId("wcmd_missing")
          });
          return toolSuccess({});
        }
      }),
      recordingLogger(logged)
    );

    const request = harness.createRequest("test.write", {});
    const result = await execution.execute(
      { ...request, authorization: { status: "allowed" } },
      harness.context
    );

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "handler_failed",
        message: "The tool failed with an internal error. Reference: corr_workspace_tools",
        details: { correlationId: "corr_workspace_tools" }
      }
    });
    const serialized = JSON.stringify(result);
    for (const leaked of [marker, "insert into", "execution_workspace_files", "wcmd_missing"]) {
      expect(serialized).not.toContain(leaked);
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      message: "Tool handler failed",
      input: {
        correlationId: "corr_workspace_tools",
        toolName: "test.write",
        toolCallId: request.toolCallId
      }
    });
    const loggedError = z.object({ error: z.instanceof(Error) }).parse(logged[0]?.input).error;
    expect(describeError(loggedError)).toContain("execution_workspace_files");
  });

  it("passes the message of an error written for the model", async () => {
    const harness = await createWorkspaceHarnessOn(suite.store, suite.clientInstance("authored"));
    const logged: Array<{ input: unknown; message?: string }> = [];
    const execution = executionFor(
      defineTool({
        name: "test.write",
        description: "Refuses with a message for the model.",
        inputSchema: z.object({}),
        async execute() {
          throw new AppError("NOT_FOUND", "Sheet 'Summary' does not exist");
        }
      }),
      recordingLogger(logged)
    );

    const result = await execution.execute(
      { ...harness.createRequest("test.write", {}), authorization: { status: "allowed" } },
      harness.context
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "handler_failed", message: "Sheet 'Summary' does not exist" }
    });
    expect(logged).toEqual([]);
  });
});

function executionFor(tool: AnyToolDefinition, logger: Logger) {
  return new InProcessToolExecution({
    registry: new ToolRegistry({ tools: [tool] }),
    getAgentToolNames: () => [tool.name],
    logger
  });
}

function recordingLogger(logged: Array<{ input: unknown; message?: string }>): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error(input, message) {
      logged.push({ input, message });
    },
    child() {
      return logger;
    }
  };
  return logger;
}

/** The error's own text and that of its causes, where a driver puts the statement. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.message}\n${describeError(error.cause ?? "")}`;
}
