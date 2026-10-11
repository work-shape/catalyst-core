import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StoreBackedAuditRecorder, type Logger } from "@vivd-catalyst/core";
import {
  ToolRegistry,
  WORKSPACE_EDIT_MAX_EDITS,
  WORKSPACE_WRITE_FILE_MAX_BYTES
} from "@vivd-catalyst/tool-execution";
import { withTestSql } from "./support/test-sql";
import { createTestToolRunner } from "./support/tool-runner";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// `workspace.write_file` and `workspace.edit_file` as an agent calls them: through the
// operation path, on Postgres, with the bytes in an object store.
//
// Every test here fails without the change: the two tools did not exist, so each call ended
// as "not registered".

type Harness = Awaited<ReturnType<typeof createWorkspaceHarness>>;

const failureSchema = z.object({
  status: z.literal("failed"),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

/** The failure an agent reads, or an error when the call did not fail. */
async function refusal(harness: Harness, toolName: string, input: unknown) {
  return failureSchema.parse(await harness.runTool(toolName, input)).error;
}

async function workspaceFiles(harness: Harness) {
  const workspace = await harness.store.executionWorkspaces.ensureExecutionWorkspace({
    clientInstanceId: harness.clientInstanceId,
    conversationId: harness.conversation.id,
    ownerUserId: harness.ownerUserId
  });
  return harness.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: harness.clientInstanceId,
    workspaceId: workspace.id
  });
}

/** The stored text of a workspace file, read from the object its row names. */
async function storedText(harness: Harness, path: string): Promise<string | undefined> {
  const file = (await workspaceFiles(harness)).find((candidate) => candidate.path === path);
  if (!file) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of (await harness.objectStore.get(file.objectKey)).body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("the definitions of the two file tools", () => {
  it("are changing tools that run on the agent's own call", async () => {
    const harness = await createWorkspaceHarness();
    for (const name of ["workspace.write_file", "workspace.edit_file"]) {
      const tool = harness.tools.find((candidate) => candidate.name === name);
      expect(tool).toMatchObject({ effect: "changing", permission: { mode: "allow" } });
      // Each says when the other one, or the shell, is the tool to take.
      expect(tool?.description).toContain("workspace.exec");
      expect(tool?.description).toContain(
        name === "workspace.write_file" ? "workspace.edit_file" : "workspace.write_file"
      );
    }
  });
});

describe("workspace.write_file", () => {
  it("creates a file below folders that did not exist, and replaces it on the next call", async () => {
    const harness = await createWorkspaceHarness();

    const created = await harness.runTool("workspace.write_file", {
      path: "/workspace/site/src/routes/index.tsx",
      content: "export const a = 1;\n"
    });

    expect(created).toMatchObject({
      status: "success",
      output: { path: "site/src/routes/index.tsx", byteSize: 20, created: true }
    });
    const [first] = await workspaceFiles(harness);
    expect(first).toMatchObject({
      path: "site/src/routes/index.tsx",
      mimeType: "text/plain",
      metadata: { source: "workspace.write_file" }
    });
    // No command ran: the file names none.
    expect(first?.lastCommandId).toBeUndefined();

    const replaced = await harness.runTool("workspace.write_file", {
      path: "site/src/routes/index.tsx",
      content: "export const a = 2; // größer\n"
    });

    expect(replaced).toMatchObject({
      status: "success",
      // Bytes, not characters: "ö" and "ß" take two each.
      output: { path: "site/src/routes/index.tsx", byteSize: 32, created: false }
    });
    expect(await workspaceFiles(harness)).toHaveLength(1);
    await expect(
      harness.runTool("workspace.read_file", { path: "site/src/routes/index.tsx" })
    ).resolves.toMatchObject({
      status: "success",
      output: { contentPreview: "export const a = 2; // größer\n" }
    });
  });

  it("writes an empty file and keeps line endings as they were sent", async () => {
    const harness = await createWorkspaceHarness();

    await expect(
      harness.runTool("workspace.write_file", { path: "empty.txt", content: "" })
    ).resolves.toMatchObject({ status: "success", output: { byteSize: 0, created: true } });
    await harness.runTool("workspace.write_file", { path: "dos.txt", content: "a\r\nb\r\n" });

    expect(await storedText(harness, "empty.txt")).toBe("");
    expect(await storedText(harness, "dos.txt")).toBe("a\r\nb\r\n");
  });

  it("refuses paths outside the workspace and says what to send", async () => {
    const harness = await createWorkspaceHarness();

    for (const path of ["../secret.txt", "notes/../../secret.txt", "/etc/passwd", "notes/"]) {
      const error = await refusal(harness, "workspace.write_file", { path, content: "x" });
      expect(error.code).toBe("validation_failed");
      expect(error.message).toContain("relative to /workspace");
    }
    expect(await workspaceFiles(harness)).toEqual([]);
  });

  it("takes content up to the limit, and refuses more with the constant and the next step", async () => {
    const harness = await createWorkspaceHarness();

    await expect(
      harness.runTool("workspace.write_file", {
        path: "full.txt",
        content: "a".repeat(WORKSPACE_WRITE_FILE_MAX_BYTES)
      })
    ).resolves.toMatchObject({
      status: "success",
      output: { byteSize: WORKSPACE_WRITE_FILE_MAX_BYTES }
    });

    // As many characters as the limit, and one byte more: the limit counts bytes.
    const error = await refusal(harness, "workspace.write_file", {
      path: "over.txt",
      content: `${"a".repeat(WORKSPACE_WRITE_FILE_MAX_BYTES - 1)}ä`
    });
    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("WORKSPACE_WRITE_FILE_MAX_BYTES");
    expect(error.message).toContain(String(WORKSPACE_WRITE_FILE_MAX_BYTES + 1));
    expect(error.message).toContain("workspace.exec");
    expect(error.message).toContain("split");
    expect(await storedText(harness, "over.txt")).toBeUndefined();
  });

  it("refuses content that is not text", async () => {
    const harness = await createWorkspaceHarness();

    const error = await refusal(harness, "workspace.write_file", {
      path: "blob.bin",
      content: "a\0b"
    });

    expect(error.message).toContain("text only");
    expect(error.message).toContain("workspace.exec");
    expect(await workspaceFiles(harness)).toEqual([]);
  });

  it("respects the size limit of the workspace, counting a replaced file once", async () => {
    const harness = await createWorkspaceHarness({ limits: { maxWorkspaceBytes: 20 } });
    await harness.runTool("workspace.write_file", { path: "a.txt", content: "123456789012345" });

    const error = await refusal(harness, "workspace.write_file", {
      path: "b.txt",
      content: "1234567890"
    });

    expect(error.message).toContain("maxWorkspaceBytes");
    expect(error.message).toContain("workspace.exec");
    expect(error.details).toMatchObject({ totalBytes: 25, maxWorkspaceBytes: 20 });
    expect(await storedText(harness, "b.txt")).toBeUndefined();
    // The same file may grow to the limit: its old size does not count twice.
    await expect(
      harness.runTool("workspace.write_file", { path: "a.txt", content: "12345678901234567890" })
    ).resolves.toMatchObject({ status: "success", output: { byteSize: 20, created: false } });
  });

  it("refuses a path that is a folder, or lies below a file", async () => {
    const harness = await createWorkspaceHarness();
    await harness.runTool("workspace.write_file", { path: "docs/plan.md", content: "plan\n" });

    const asFolder = await refusal(harness, "workspace.write_file", {
      path: "docs",
      content: "x"
    });
    const belowFile = await refusal(harness, "workspace.write_file", {
      path: "docs/plan.md/draft.md",
      content: "x"
    });

    expect(asFolder.message).toContain("'docs' is a folder");
    expect(belowFile.message).toContain("'docs/plan.md' is a file");
    expect((await workspaceFiles(harness)).map((file) => file.path)).toEqual(["docs/plan.md"]);
  });

  it("turns a file that was not text into a text file, so that it can be read again", async () => {
    const harness = await createWorkspaceHarness();
    await harness.putWorkspaceFile({
      path: "data.bin",
      objectKey: "workspace/data.bin",
      bytes: new Uint8Array([0, 1, 2]),
      mimeType: "application/octet-stream"
    });
    await harness.putWorkspaceFile({
      path: "page.html",
      objectKey: "workspace/page.html",
      bytes: "<p>old</p>",
      mimeType: "text/html"
    });

    await harness.runTool("workspace.write_file", { path: "data.bin", content: "now text\n" });
    await harness.runTool("workspace.write_file", { path: "page.html", content: "<p>new</p>" });

    const files = await workspaceFiles(harness);
    expect(files.find((file) => file.path === "data.bin")?.mimeType).toBe("text/plain");
    // A text type is kept.
    expect(files.find((file) => file.path === "page.html")?.mimeType).toBe("text/html");
    await expect(
      harness.runTool("workspace.read_file", { path: "data.bin" })
    ).resolves.toMatchObject({ status: "success", output: { contentPreview: "now text\n" } });
  });
});

describe("workspace.edit_file", () => {
  const original = ["alpha = 1", "beta = 2", "gamma = 3", "beta_copy = 2", ""].join("\n");

  async function harnessWithFile(text = original, limits?: { maxReadFileBytes: number }) {
    const harness = await createWorkspaceHarness(limits ? { limits } : {});
    await harness.runTool("workspace.write_file", { path: "config.ini", content: text });
    return harness;
  }

  it("replaces each text where it stands in the file as it is, in one write", async () => {
    const harness = await harnessWithFile();

    const edited = await harness.runTool("workspace.edit_file", {
      path: "config.ini",
      edits: [
        // Given out of order, and the second one's result holds the first one's oldText:
        // every edit is searched in the file as it was.
        { oldText: "gamma = 3", newText: "gamma = 30\nalpha = 1 (copy)" },
        { oldText: "alpha = 1", newText: "alpha = 10" }
      ]
    });

    const expected = [
      "alpha = 10",
      "beta = 2",
      "gamma = 30",
      "alpha = 1 (copy)",
      "beta_copy = 2",
      ""
    ].join("\n");
    expect(edited).toMatchObject({
      status: "success",
      output: { path: "config.ini", byteSize: expected.length, editsApplied: 2 }
    });
    expect(await storedText(harness, "config.ini")).toBe(expected);
    const [file] = await workspaceFiles(harness);
    expect(file?.metadata).toMatchObject({ modifiedBy: "workspace.edit_file" });
    expect(file?.lastCommandId).toBeUndefined();
  });

  it("matches exactly and leaves every other byte alone, line endings included", async () => {
    const harness = await harnessWithFile("one\r\n\ttwo  \r\nthree");

    await harness.runTool("workspace.edit_file", {
      path: "config.ini",
      edits: [{ oldText: "\ttwo  \r\n", newText: "\tTWO\r\n" }]
    });

    expect(await storedText(harness, "config.ini")).toBe("one\r\n\tTWO\r\nthree");
  });

  it("says that a text was not found, and to read the file again", async () => {
    const harness = await harnessWithFile();

    const error = await refusal(harness, "workspace.edit_file", {
      path: "config.ini",
      edits: [{ oldText: "delta = 4", newText: "delta = 5" }]
    });

    expect(error.code).toBe("handler_failed");
    expect(error.message).toContain("edits[0].oldText was not found in 'config.ini'");
    expect(error.message).toContain("Read the file again with workspace.read_file");
    expect(error.message).toContain("match exactly, including spaces, tabs and line breaks");
    expect(error.details).toMatchObject({ path: "config.ini", edit: 0, occurrences: 0 });
    expect(await storedText(harness, "config.ini")).toBe(original);
  });

  it("names the line when only line endings or blanks at line ends differ", async () => {
    const harness = await harnessWithFile("first\r\nsecond  \r\nthird\r\n");

    const error = await refusal(harness, "workspace.edit_file", {
      path: "config.ini",
      edits: [{ oldText: "second\nthird", newText: "2\n3" }]
    });

    expect(error.message).toContain("was not found");
    expect(error.message).toContain("at line 2 with other line endings or blanks at line ends");
    expect(error.details).toMatchObject({ nearLine: 2 });
    // The exact rule holds: the near match is named and not edited.
    expect(await storedText(harness, "config.ini")).toBe("first\r\nsecond  \r\nthird\r\n");
  });

  it("says how often a text occurs and where, and to add surrounding lines", async () => {
    const harness = await harnessWithFile();

    const error = await refusal(harness, "workspace.edit_file", {
      path: "config.ini",
      edits: [{ oldText: " = 2", newText: " = 22" }]
    });

    expect(error.code).toBe("handler_failed");
    expect(error.message).toContain(
      "edits[0].oldText occurs 2 times in 'config.ini', at lines 2, 4"
    );
    expect(error.message).toContain("Add surrounding lines to oldText");
    expect(error.details).toMatchObject({ occurrences: 2, lines: [2, 4] });
    expect(await storedText(harness, "config.ini")).toBe(original);
  });

  it("applies no edit when one of them fails", async () => {
    const harness = await harnessWithFile();

    const error = await refusal(harness, "workspace.edit_file", {
      path: "config.ini",
      edits: [
        { oldText: "alpha = 1", newText: "alpha = 10" },
        { oldText: "gamma = 3", newText: "gamma = 30" },
        { oldText: "missing", newText: "x" }
      ]
    });

    expect(error.message).toContain("edits[2].oldText was not found");
    expect(error.message).toContain("Nothing was changed");
    expect(await storedText(harness, "config.ini")).toBe(original);
    // One write stored the file; the refused edit stored nothing beside it.
    expect(harness.objectStore.keys()).toHaveLength(1);
  });

  it("refuses two edits that change the same text", async () => {
    const harness = await harnessWithFile();

    const error = await refusal(harness, "workspace.edit_file", {
      path: "config.ini",
      edits: [
        { oldText: "alpha = 1\nbeta = 2\ngamma", newText: "x" },
        { oldText: "beta = 2\ngamma = 3", newText: "y" }
      ]
    });

    expect(error.message).toContain("edits[0] and edits[1] change the same text");
    expect(error.message).toContain("Merge them into one edit");
    expect(await storedText(harness, "config.ini")).toBe(original);

    // Two edits that touch each other without sharing a character both apply.
    await expect(
      harness.runTool("workspace.edit_file", {
        path: "config.ini",
        edits: [
          { oldText: "alpha = 1\n", newText: "a\n" },
          { oldText: "beta = 2\ngamma", newText: "b\ng" }
        ]
      })
    ).resolves.toMatchObject({ status: "success", output: { editsApplied: 2 } });
    expect(await storedText(harness, "config.ini")).toBe("a\nb\ng = 3\nbeta_copy = 2\n");
  });

  it("says that the file does not exist, and how to find or create it", async () => {
    const harness = await harnessWithFile();

    const error = await refusal(harness, "workspace.edit_file", {
      path: "other.ini",
      edits: [{ oldText: "a", newText: "b" }]
    });

    expect(error.message).toContain("'other.ini' was not found");
    expect(error.message).toContain("Call workspace.list_files");
    expect(error.message).toContain("workspace.write_file");
  });

  it("takes the most edits a call may have, and refuses one more with the constant", async () => {
    const lines = Array.from(
      { length: WORKSPACE_EDIT_MAX_EDITS + 1 },
      (_, index) => `row-${index};`
    );
    const harness = await harnessWithFile(lines.join("\n"));
    const edits = lines.map((line) => ({ oldText: line, newText: line.toUpperCase() }));

    const error = await refusal(harness, "workspace.edit_file", { path: "config.ini", edits });

    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("WORKSPACE_EDIT_MAX_EDITS");
    expect(error.message).toContain(`got ${WORKSPACE_EDIT_MAX_EDITS + 1}`);
    expect(error.message).toContain("Send the edits in several calls");
    expect(await storedText(harness, "config.ini")).toBe(lines.join("\n"));

    await expect(
      harness.runTool("workspace.edit_file", {
        path: "config.ini",
        edits: edits.slice(0, WORKSPACE_EDIT_MAX_EDITS)
      })
    ).resolves.toMatchObject({
      status: "success",
      output: { editsApplied: WORKSPACE_EDIT_MAX_EDITS }
    });
  });

  it("refuses an edit that has no text to find, or changes nothing", async () => {
    const harness = await harnessWithFile();

    const empty = await refusal(harness, "workspace.edit_file", {
      path: "config.ini",
      edits: [{ oldText: "", newText: "x" }]
    });
    const same = await refusal(harness, "workspace.edit_file", {
      path: "config.ini",
      edits: [{ oldText: "alpha = 1", newText: "alpha = 1" }]
    });

    expect(empty.message).toContain("edits[0].oldText is empty");
    expect(same.message).toContain("replaces text with the same text");
    expect(await storedText(harness, "config.ini")).toBe(original);
  });

  it("refuses paths outside the workspace, files that are not text, and files too large to search", async () => {
    const harness = await harnessWithFile(original, { maxReadFileBytes: 64 });
    await harness.putWorkspaceFile({
      path: "data.bin",
      objectKey: "workspace/data.bin",
      bytes: new Uint8Array([0, 1, 2, 3]),
      mimeType: "application/octet-stream"
    });
    await harness.runTool("workspace.write_file", { path: "big.txt", content: "x".repeat(65) });
    const edits = [{ oldText: "x", newText: "y" }];

    const traversal = await refusal(harness, "workspace.edit_file", { path: "../a.txt", edits });
    const binary = await refusal(harness, "workspace.edit_file", { path: "data.bin", edits });
    const large = await refusal(harness, "workspace.edit_file", { path: "big.txt", edits });

    expect(traversal.message).toContain("relative to /workspace");
    expect(binary.message).toContain("not a UTF-8 text file");
    expect(binary.message).toContain("workspace.exec");
    expect(large.message).toContain("maxReadFileBytes");
    expect(large.message).toContain("workspace.exec");
  });

  it("respects the size limit of the workspace", async () => {
    const harness = await createWorkspaceHarness({ limits: { maxWorkspaceBytes: 20 } });
    await harness.runTool("workspace.write_file", { path: "a.txt", content: "1234567890" });

    const error = await refusal(harness, "workspace.edit_file", {
      path: "a.txt",
      edits: [{ oldText: "5", newText: "five-five-five-five" }]
    });

    expect(error.message).toContain("maxWorkspaceBytes");
    expect(error.details).toMatchObject({ totalBytes: 28, maxWorkspaceBytes: 20 });
    expect(await storedText(harness, "a.txt")).toBe("1234567890");
  });
});

describe("what a write and an edit leave behind", () => {
  it("keeps no file content in operation runs, audit events or log lines", async () => {
    const harness = await createWorkspaceHarness();
    const logged: unknown[] = [];
    const logger: Logger = {
      debug: (...args) => void logged.push(args),
      info: (...args) => void logged.push(args),
      warn: (...args) => void logged.push(args),
      error: (...args) => void logged.push(args),
      child: () => logger
    };
    // The harness keeps its runs in memory. Here they are rows, as on an instance.
    const run = createTestToolRunner({
      registry: new ToolRegistry({ tools: harness.tools }),
      getAgentToolNames: () => harness.tools.map((tool) => tool.name),
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: harness.clientInstanceId,
        store: harness.store.audit
      }),
      runs: harness.store.operationRuns,
      logger
    });
    const call = (toolName: string, input: unknown) =>
      run(harness.createRequest(toolName, input), harness.context);
    const secrets = ["CONTENT-MARKER-7f3a", "OLDTEXT-MARKER-91bc", "NEWTEXT-MARKER-c40e"];
    const [content, oldText, newText] = secrets;

    const written = await call("workspace.write_file", {
      path: "notes/secret.txt",
      content: `${content}\n${oldText}\n`
    });
    const edited = await call("workspace.edit_file", {
      path: "notes/secret.txt",
      edits: [{ oldText, newText }]
    });
    // Refused calls keep nothing either: a text that is not there, and content that is too large.
    const missing = await call("workspace.edit_file", {
      path: "notes/secret.txt",
      edits: [{ oldText: `${oldText}-gone`, newText }]
    });
    const tooLarge = await call("workspace.write_file", {
      path: "notes/large.txt",
      content: `${content}${"x".repeat(WORKSPACE_WRITE_FILE_MAX_BYTES)}`
    });
    expect([written.status, edited.status, missing.status, tooLarge.status]).toEqual([
      "success",
      "success",
      "failed",
      "failed"
    ]);

    const { runRows, auditRows } = await withTestSql(async (sql) => ({
      runRows: await sql<{ row: string }[]>`
        select to_jsonb(r)::text as row from operation_runs r
        where client_instance_id = ${harness.clientInstanceId}`,
      auditRows: await sql<{ row: string }[]>`
        select to_jsonb(a)::text as row from audit_events a
        where client_instance_id = ${harness.clientInstanceId}`
    }));
    expect(runRows).toHaveLength(4);
    expect(auditRows.length).toBeGreaterThanOrEqual(12);
    const stored = [...runRows, ...auditRows].map(({ row }) => row).join("\n");
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
    }
    expect(JSON.stringify(logged)).not.toContain("MARKER");

    // What they do hold: the path, sizes, a checksum and a count.
    const runs = await harness.store.operationRuns.list({
      clientInstanceId: harness.clientInstanceId
    });
    expect(
      runs.find((row) => row.operation === "workspace.write_file" && row.output)
    ).toMatchObject({
      status: "done",
      effect: "changing",
      output: { value: { path: "notes/secret.txt", byteSize: 40, created: true } }
    });
    expect(runs.find((row) => row.operation === "workspace.edit_file" && row.output)).toMatchObject(
      {
        status: "done",
        output: { value: { path: "notes/secret.txt", byteSize: 40, editsApplied: 1 } }
      }
    );
    expect(
      runs
        .filter((row) => row.status === "failed")
        .map((row) => row.error?.code)
        .sort()
    ).toEqual(["handler_failed", "validation_failed"]);
    const completed = (
      await harness.store.audit.listAuditEvents({
        clientInstanceId: harness.clientInstanceId,
        type: "operation.completed"
      })
    ).map((event) => event.metadata);
    expect(completed).toContainEqual(
      expect.objectContaining({
        auditAction: "workspace.write_file",
        auditSubject: "notes/secret.txt",
        auditMetadata: {
          byteSize: 40,
          checksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
          created: true
        }
      })
    );
    expect(completed).toContainEqual(
      expect.objectContaining({
        auditAction: "workspace.edit_file",
        auditSubject: "notes/secret.txt",
        auditMetadata: { byteSizeBefore: 40, byteSizeAfter: 40, editCount: 1 }
      })
    );
  });
});
