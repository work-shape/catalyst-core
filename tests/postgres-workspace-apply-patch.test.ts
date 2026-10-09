import { describe, expect, it } from "vitest";
import { usePostgresSuite } from "./support/postgres-suite";
import { createWorkspaceHarnessOn } from "./support/workspace-tools-harness";

describe("workspace.apply_patch on Postgres", () => {
  const suite = usePostgresSuite("apply_patch");

  it("creates, updates and deletes files without naming a workspace command", async () => {
    const harness = await createWorkspaceHarnessOn(suite.store, suite.clientInstance("patch"));

    const created = await harness.runTool("workspace.apply_patch", {
      patch: [
        "--- /dev/null",
        "+++ b/scripts/build.py",
        "@@ -0,0 +1,2 @@",
        '+print("hello")',
        "+VALUE = 1"
      ].join("\n")
    });
    expect(created).toMatchObject({
      status: "success",
      output: { changedFiles: [{ path: "scripts/build.py" }], deletedFiles: [] }
    });

    const updated = await harness.runTool("workspace.apply_patch", {
      patch: [
        "--- a/scripts/build.py",
        "+++ b/scripts/build.py",
        "@@ -1,2 +1,2 @@",
        ' print("hello")',
        "-VALUE = 1",
        "+VALUE = 2"
      ].join("\n")
    });
    expect(updated).toMatchObject({
      status: "success",
      output: { changedFiles: [{ path: "scripts/build.py" }] }
    });

    const workspace = await suite.store.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      ownerUserId: harness.ownerUserId
    });
    const [file] = await suite.store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: workspace.id
    });
    expect(file).toMatchObject({
      path: "scripts/build.py",
      metadata: { modifiedBy: "workspace.apply_patch" }
    });
    expect(file?.lastCommandId).toBeUndefined();
    const read = await harness.runTool("workspace.read_file", { path: "scripts/build.py" });
    expect(read).toMatchObject({
      status: "success",
      output: { contentPreview: 'print("hello")\nVALUE = 2\n' }
    });

    const deleted = await harness.runTool("workspace.apply_patch", {
      patch: [
        "--- a/scripts/build.py",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        '-print("hello")',
        "-VALUE = 2"
      ].join("\n")
    });
    expect(deleted).toMatchObject({
      status: "success",
      output: { changedFiles: [], deletedFiles: [{ path: "scripts/build.py" }] }
    });
    await expect(
      suite.store.executionWorkspaces.listWorkspaceFiles({
        clientInstanceId: harness.clientInstanceId,
        workspaceId: workspace.id
      })
    ).resolves.toEqual([]);
  });
});
