import { OperationExecutionStop } from "@work-shape/catalyst-core";
import { createWorkspaceCommandClient } from "@work-shape/catalyst-tool-execution";
import { describe, expect, it } from "vitest";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { useWorkspaceCommandJobFixture } from "./support/workspace-command-job-fixture";

describe("workspace commands stopped by the operation executor", () => {
  const db = usePostgresSuite("command_stop");
  const harness = useJobExecutorHarness(db);
  const { createFixture } = useWorkspaceCommandJobFixture(db, harness);

  it.each(["timeout", "aborted"] as const)(
    "uses the executor's %s reason even before the wait deadline",
    async (kind) => {
      const fixture = await createFixture(`executor_${kind}`);
      const queued = await fixture.enqueue("sleep 60");
      const client = createWorkspaceCommandClient({
        stores: db.store,
        now: () => new Date().toISOString()
      });
      const result = await client.await(
        { command: queued },
        {
          signal: AbortSignal.abort(new OperationExecutionStop(kind, new Error("probe"))),
          deadline: new Date(Date.now() + 60_000)
        }
      );
      const reason =
        kind === "timeout"
          ? "Workspace command exceeded the tool execution deadline"
          : "Workspace command was cancelled with its agent run";
      expect(result).toMatchObject({
        status: kind === "timeout" ? "timed_out" : "cancelled",
        reason,
        command: { id: queued.id, status: "cancelled", cancellationReason: reason }
      });
      expect(await fixture.command(queued)).toMatchObject({ cancellationReason: reason });
    }
  );
});
