import { asWorkspaceCommandId } from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

type Harness = Awaited<ReturnType<typeof createWorkspaceHarness>>;

describe("workspace.exec results when the wait for a command gives up", () => {
  it("reports the tool execution deadline as timed_out and cancels the command", async () => {
    const harness = await createWorkspaceHarness({
      execResultWaitMs: null,
      execResultPollIntervalMs: 5
    });

    const result = await harness.runTool(
      "workspace.exec",
      { command: "sleep 60" },
      { ...harness.context, deadline: new Date(Date.now() + 50) }
    );

    const commandId = commandIdOf(result);
    expect(result).toEqual({
      status: "timed_out",
      error: {
        code: "timed_out",
        message: "Workspace command exceeded the tool execution deadline",
        details: { commandId, status: "cancelled" }
      }
    });
    await expect(storedCommand(harness, commandId)).resolves.toMatchObject({
      status: "cancelled",
      cancellationReason: "Workspace command exceeded the tool execution deadline"
    });
  });

  it("reports the wait limit as a failure with the wait it was given and cancels the command", async () => {
    const harness = await createWorkspaceHarness({
      execResultWaitMs: 20,
      execResultPollIntervalMs: 5
    });

    const result = await harness.runTool("workspace.exec", { command: "sleep 60" });

    const commandId = commandIdOf(result);
    expect(result).toEqual({
      status: "failed",
      error: {
        code: "handler_failed",
        message: "Workspace command did not complete before the tool wait limit",
        details: { commandId, status: "cancelled", waitMs: 20 }
      }
    });
    await expect(storedCommand(harness, commandId)).resolves.toMatchObject({
      status: "cancelled",
      cancellationReason: "Workspace command did not complete before the tool wait limit"
    });
  });

  it("reports a command whose row is gone as a failure and leaves the queue alone", async () => {
    const harness = await createWorkspaceHarness({
      execResultWaitMs: null,
      execResultPollIntervalMs: 5,
      serviceStore(store) {
        return {
          ...store,
          executionWorkspaces: new Proxy(store.executionWorkspaces, {
            get(target, property, receiver) {
              if (property === "getWorkspaceCommand") {
                return () => Promise.resolve(undefined);
              }
              const value: unknown = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
          })
        };
      }
    });

    const result = await harness.runTool("workspace.exec", { command: "sleep 60" });

    const commandId = commandIdOf(result);
    expect(result).toEqual({
      status: "failed",
      error: {
        code: "handler_failed",
        message: "Workspace command is no longer available",
        details: { commandId }
      }
    });
    await expect(storedCommand(harness, commandId)).resolves.toMatchObject({ status: "queued" });
  });
});

type ToolResult = Awaited<ReturnType<Harness["runTool"]>>;

function commandIdOf(result: ToolResult): string {
  const commandId =
    result.status === "success" ? undefined : jsonObjectOf(result.error.details).commandId;
  if (typeof commandId !== "string") {
    throw new Error("Expected the result to name its workspace command");
  }
  return commandId;
}

function jsonObjectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function storedCommand(harness: Harness, commandId: string) {
  return harness.store.executionWorkspaces.getWorkspaceCommand({
    clientInstanceId: harness.clientInstanceId,
    commandId: asWorkspaceCommandId(commandId)
  });
}
