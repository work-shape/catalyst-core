import { describe, expect, it, vi } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { DEFAULT_LIMITS, WORKSPACE_READ_DEFAULT_LINES } from "@vivd-catalyst/tool-execution";
import { jsonObject } from "./support/assertions";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

type WorkspaceHarness = Awaited<ReturnType<typeof createWorkspaceHarness>>;

async function putText(harness: WorkspaceHarness, path: string, text: string | Uint8Array) {
  await harness.putWorkspaceFile({
    path,
    objectKey: `workspace/${path}`,
    bytes: text,
    mimeType: "text/plain"
  });
}

async function read(harness: WorkspaceHarness, input: Record<string, unknown>) {
  const result = await harness.runTool("workspace.read_file", input);
  if (result.status !== "success") {
    throw new Error(`Expected workspace.read_file to succeed: ${JSON.stringify(result)}`);
  }
  return jsonObject(result.output);
}

async function readFailure(harness: WorkspaceHarness, input: Record<string, unknown>) {
  const result = await harness.runTool("workspace.read_file", input);
  if (result.status !== "failed") {
    throw new Error("Expected workspace.read_file to fail");
  }
  return result.error;
}

function workspaceOf(harness: WorkspaceHarness) {
  return harness.store.executionWorkspaces.getExecutionWorkspaceForConversation({
    clientInstanceId: harness.clientInstanceId,
    conversationId: harness.conversation.id
  });
}

describe("workspace.read_file by lines", () => {
  // Fails without the change: the old tool returned the first 16 KiB and had no way to go on.
  it("pages through a file larger than one answer to its end with nextOffset", async () => {
    const harness = await createWorkspaceHarness();
    const lines = Array.from(
      { length: 1500 },
      (_, index) => `line ${index + 1} ${"x".repeat(index % 90)}\n`
    );
    const content = lines.join("");
    expect(Buffer.byteLength(content)).toBeGreaterThan(3 * DEFAULT_LIMITS.maxReadPreviewBytes);
    await putText(harness, "notes/long.txt", content);

    let collected = "";
    let offset: number | undefined;
    let expectedStart = 1;
    let pages = 0;
    for (;;) {
      const page = await read(harness, {
        path: "notes/long.txt",
        ...(offset === undefined ? {} : { offset })
      });
      pages += 1;
      const preview = String(page.contentPreview);
      expect(page.startLine).toBe(expectedStart);
      expect(page.totalLines).toBe(1500);
      expect(preview.endsWith("\n")).toBe(true);
      expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(DEFAULT_LIMITS.maxReadPreviewBytes);
      expect(Number(page.endLine) - Number(page.startLine) + 1).toBeLessThanOrEqual(
        WORKSPACE_READ_DEFAULT_LINES
      );
      expect(preview).toBe(lines.slice(Number(page.startLine) - 1, Number(page.endLine)).join(""));
      collected += preview;
      if (page.nextOffset === undefined) {
        expect(page.truncated).toBe(false);
        expect(page.hint).toBeUndefined();
        expect(page.endLine).toBe(1500);
        break;
      }
      expect(page.truncated).toBe(true);
      expect(page.nextOffset).toBe(Number(page.endLine) + 1);
      expect(page.hint).toContain(`offset ${String(page.nextOffset)}`);
      offset = Number(page.nextOffset);
      expectedStart = offset;
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(3);
    expect(collected).toBe(content);
  });

  // Fails without the change: there was no line limit, and no `limit` or `offset` input.
  it("returns the default number of lines, and the lines a call asks for", async () => {
    const harness = await createWorkspaceHarness();
    const content = Array.from({ length: 1000 }, (_, index) => `${index + 1}\n`).join("");
    await putText(harness, "numbers.txt", content);

    const first = await read(harness, { path: "numbers.txt" });
    expect(first).toMatchObject({
      startLine: 1,
      endLine: WORKSPACE_READ_DEFAULT_LINES,
      totalLines: 1000,
      nextOffset: WORKSPACE_READ_DEFAULT_LINES + 1,
      truncated: true
    });

    const middle = await read(harness, { path: "numbers.txt", offset: 500, limit: 3 });
    expect(middle).toMatchObject({
      contentPreview: "500\n501\n502\n",
      startLine: 500,
      endLine: 502,
      totalLines: 1000,
      nextOffset: 503,
      truncated: true
    });

    const tail = await read(harness, { path: "numbers.txt", offset: 999, limit: 50 });
    expect(tail).toMatchObject({
      contentPreview: "999\n1000\n",
      startLine: 999,
      endLine: 1000,
      truncated: false
    });
    expect(tail.nextOffset).toBeUndefined();
  });

  it("counts a last line without a line feed and keeps line endings as they are", async () => {
    const harness = await createWorkspaceHarness();
    await putText(harness, "mixed.txt", "one\r\ntwo\n\nfour");

    expect(await read(harness, { path: "mixed.txt" })).toMatchObject({
      contentPreview: "one\r\ntwo\n\nfour",
      startLine: 1,
      endLine: 4,
      totalLines: 4,
      truncated: false
    });
    expect(await read(harness, { path: "mixed.txt", offset: 3, limit: 1 })).toMatchObject({
      contentPreview: "\n",
      startLine: 3,
      endLine: 3,
      nextOffset: 4
    });
  });

  // Fails without the change: the old cut at byte 10 split the two-byte character in line 2.
  it("ends at a whole line when the byte limit falls inside a multi-byte character", async () => {
    const harness = await createWorkspaceHarness({ limits: { maxReadPreviewBytes: 10 } });
    await putText(harness, "umlaut.txt", "aaaa\nbbbbé\ncc\n");

    const first = await read(harness, { path: "umlaut.txt" });
    expect(first).toMatchObject({
      contentPreview: "aaaa\n",
      startLine: 1,
      endLine: 1,
      totalLines: 3,
      nextOffset: 2,
      truncated: true
    });
    const rest = await read(harness, { path: "umlaut.txt", offset: 2 });
    expect(rest).toMatchObject({
      contentPreview: "bbbbé\ncc\n",
      startLine: 2,
      endLine: 3,
      truncated: false
    });
  });

  // Fails without the change: a line longer than the answer was cut inside a character.
  it("cuts a single line that is longer than one answer at a whole character and says so", async () => {
    const harness = await createWorkspaceHarness({ limits: { maxReadPreviewBytes: 5 } });
    await putText(harness, "wide.txt", "ääääää\nnext\n");

    const first = await read(harness, { path: "wide.txt" });
    expect(first).toMatchObject({
      contentPreview: "ää",
      startLine: 1,
      endLine: 1,
      totalLines: 2,
      nextOffset: 2,
      truncated: true,
      lineCut: true
    });
    expect(String(first.contentPreview)).not.toContain("\uFFFD");
    expect(first.hint).toContain("Line 1 has 13 bytes");
    expect(first.hint).toContain("workspace.exec");
    expect(first.hint).toContain("offset 2");
    const whole = await read(harness, { path: "wide.txt", offset: 2 });
    expect(whole).toMatchObject({ contentPreview: "next\n", truncated: false });
    expect(whole.lineCut).toBeUndefined();

    // The cut line is the last one: nothing to continue with, and the answer still says it
    // is not the whole file.
    await putText(harness, "one-line.json", "ääääää");
    const last = await read(harness, { path: "one-line.json" });
    expect(last).toMatchObject({
      contentPreview: "ää",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: true,
      lineCut: true
    });
    expect(last.nextOffset).toBeUndefined();
    expect(last.hint).toContain("Line 1 has 12 bytes");
    expect(last.hint).toContain("workspace.exec");

    const readTool = harness.tools.find((tool) => tool.name === "workspace.read_file");
    expect(readTool?.description).toContain(
      "a single line that is longer than one answer is cut inside the line"
    );
    expect(readTool?.description).toContain("lineCut true");
    expect(readTool?.description).not.toContain("always ends at a whole line");
  });

  // Fails without the change: the answer had no line fields.
  it("reads an empty file as zero lines", async () => {
    const harness = await createWorkspaceHarness();
    await putText(harness, "empty.txt", "");

    const empty = await read(harness, { path: "empty.txt" });
    expect(empty).toMatchObject({
      contentPreview: "",
      byteSize: 0,
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      truncated: false
    });
    expect(empty.nextOffset).toBeUndefined();

    const past = await readFailure(harness, { path: "empty.txt", offset: 2 });
    expect(past.code).toBe("validation_failed");
    expect(past.message).toContain("is empty");
  });

  // Fails without the change: `offset` was not an input.
  it("refuses an offset past the end and names the offsets that exist", async () => {
    const harness = await createWorkspaceHarness();
    await putText(harness, "three.txt", "a\nb\nc\n");

    const past = await readFailure(harness, { path: "three.txt", offset: 4 });
    expect(past.code).toBe("validation_failed");
    expect(past.message).toBe(
      "Offset 4 is past the end of 'three.txt', which has 3 lines. Use an offset from 1 to 3."
    );
    expect(past.details).toMatchObject({ path: "three.txt", offset: 4, totalLines: 3 });

    const zero = await harness.runTool("workspace.read_file", { path: "three.txt", offset: 0 });
    expect(zero.status).toBe("failed");
  });

  // Fails without the change: the ceiling was 128 KiB, so the first file was refused too.
  it("reads a file of 8 MiB and refuses a larger one with the constant and the next step", async () => {
    const harness = await createWorkspaceHarness();
    const ceiling = 8 * 1024 * 1024;
    expect(DEFAULT_LIMITS.maxReadFileBytes).toBe(ceiling);
    const line = `${"y".repeat(1023)}\n`;
    const atCeiling = new TextEncoder().encode(line.repeat(ceiling / 1024));
    const overCeiling = new Uint8Array(ceiling + 1).fill(0x79);
    await putText(harness, "big/at-ceiling.txt", atCeiling);
    await putText(harness, "big/over-ceiling.txt", overCeiling);

    const first = await read(harness, { path: "big/at-ceiling.txt" });
    expect(first).toMatchObject({
      byteSize: ceiling,
      startLine: 1,
      endLine: 16,
      totalLines: 8192,
      nextOffset: 17,
      truncated: true
    });
    const last = await read(harness, { path: "big/at-ceiling.txt", offset: 8192 });
    expect(last).toMatchObject({ contentPreview: line, endLine: 8192, truncated: false });

    // The size on the file row decides. The bytes of a file over the ceiling are not asked for.
    const get = vi.spyOn(harness.objectStore, "get");
    const head = vi.spyOn(harness.objectStore, "head");
    const refused = await readFailure(harness, { path: "big/over-ceiling.txt" });
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(refused.message).toContain("maxReadFileBytes");
    expect(refused.message).toContain(String(ceiling));
    expect(refused.message).toContain("workspace.exec");
    expect(refused.details).toMatchObject({ byteSize: ceiling + 1, maxReadFileBytes: ceiling });
  });

  // Fails without the change: both tools created the workspace row before they answered.
  it("reads and lists without creating a workspace for the conversation", async () => {
    const harness = await createWorkspaceHarness();
    await expect(workspaceOf(harness)).resolves.toBeUndefined();

    const listed = await harness.runTool("workspace.list_files", {});
    expect(listed.status).toBe("success");
    if (listed.status !== "success") {
      throw new Error("Expected workspace.list_files to succeed");
    }
    expect(listed.output).toEqual({ files: [] });

    const missing = await readFailure(harness, { path: "notes.txt" });
    expect(missing.code).toBe("handler_failed");
    expect(missing.message).toBe(
      "Workspace file 'notes.txt' was not found. Call workspace.list_files to see the paths that exist."
    );

    await expect(workspaceOf(harness)).resolves.toBeUndefined();
  });

  // Fails without the change: the old texts said what was wrong and stopped there.
  it("names the next step in every refusal of a read", async () => {
    const harness = await createWorkspaceHarness({ limits: { maxReadFileBytes: 64 } });
    await putText(harness, "present.txt", "here\n");
    await harness.putWorkspaceFile({
      path: "bin/blob.dat",
      objectKey: "workspace/bin/blob.dat",
      bytes: new Uint8Array([0, 1, 2, 3]),
      mimeType: "application/octet-stream"
    });
    await harness.putWorkspaceFile({
      path: "image.png",
      objectKey: "workspace/image.png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png"
    });
    await putText(harness, "latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    await putText(harness, "large.txt", "x".repeat(80));

    const missing = await readFailure(harness, { path: "absent.txt" });
    expect(missing.message).toContain("was not found");
    expect(missing.message).toContain("workspace.list_files");

    const binary = await readFailure(harness, { path: "bin/blob.dat" });
    expect(binary.message).toContain("binary");
    expect(binary.message).toContain("workspace.exec");
    expect(binary.message).toContain("workspace.preview_images");

    const image = await readFailure(harness, { path: "image.png" });
    expect(image.message).toContain("not a supported text MIME type");
    expect(image.message).toContain("workspace.exec");
    expect(image.message).toContain("workspace.preview_images");

    const latin1 = await readFailure(harness, { path: "latin1.txt" });
    expect(latin1.message).toContain("not valid UTF-8");
    expect(latin1.message).toContain("workspace.exec");

    const large = await readFailure(harness, { path: "large.txt" });
    expect(large.message).toContain("maxReadFileBytes, 64 bytes");
    expect(large.message).toContain("workspace.exec");

    for (const [path, what] of [
      ["/workspace", "must name a file"],
      ["notes/", "must not end with a slash"],
      ["../outside.txt", "cannot traverse outside the workspace"],
      ["/etc/passwd", "must be relative"],
      ["notes\\a.txt", "must use forward slashes"],
      ["   ", "cannot be blank"]
    ] as const) {
      const invalid = await readFailure(harness, { path });
      expect(invalid.code).toBe("validation_failed");
      expect(invalid.message).toContain(what);
      expect(invalid.message).toContain("Pass a path relative to /workspace");
      expect(invalid.message).toContain("workspace.list_files");
    }
  });

  // Fails without the change: a read listed every file row of the workspace to find one.
  it("finds the file by workspace and path without listing the workspace", async () => {
    const harness = await createWorkspaceHarness();
    const stored = await harness.putWorkspaceFile({
      path: "notes/a.txt",
      objectKey: "workspace/notes/a.txt",
      bytes: "alpha\n",
      mimeType: "text/plain"
    });
    await putText(harness, "notes/b.txt", "beta\n");
    const files = harness.store.executionWorkspaces;
    const key = {
      clientInstanceId: harness.clientInstanceId,
      workspaceId: stored.workspaceId
    };

    await expect(files.getWorkspaceFile({ ...key, path: "notes/a.txt" })).resolves.toMatchObject({
      path: "notes/a.txt",
      byteSize: 6,
      objectKey: "workspace/notes/a.txt"
    });
    await expect(files.getWorkspaceFile({ ...key, path: "notes/c.txt" })).resolves.toBeUndefined();
    await expect(
      files.getWorkspaceFile({
        ...key,
        clientInstanceId: asClientInstanceId("another_instance"),
        path: "notes/a.txt"
      })
    ).resolves.toBeUndefined();

    const list = vi.spyOn(files, "listWorkspaceFiles");
    expect(await read(harness, { path: "notes/a.txt" })).toMatchObject({
      contentPreview: "alpha\n"
    });
    expect((await readFailure(harness, { path: "notes/c.txt" })).message).toContain(
      "was not found"
    );
    expect(list).not.toHaveBeenCalled();
  });

  // Fails without the change: the lookup of a reading tool did not ask whether the
  // Conversation is still active, which the creating path does.
  it("refuses a read and a list for a conversation that is not active, as a changing tool is refused", async () => {
    const harness = await createWorkspaceHarness();
    await putText(harness, "kept.txt", "kept\n");
    await harness.store.conversations.deleteConversation({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      deletedAt: "2026-06-29T12:05:00.000Z"
    });

    const changing = await harness.runTool("workspace.exec", { command: "true" });
    const reading = await harness.runTool("workspace.read_file", { path: "kept.txt" });
    const listing = await harness.runTool("workspace.list_files", {});

    expect(changing).toMatchObject({
      status: "failed",
      error: { message: "Conversation is not available" }
    });
    expect(reading).toEqual(changing);
    expect(listing).toEqual(changing);
  });

  // Fails without the change: the audit summary had no line range.
  it("records path, size and line range, and no file content, in audit and Operation Run", async () => {
    const harness = await createWorkspaceHarness({ withAuditRecorder: true });
    await putText(harness, "secret.txt", "first-secret-line\nsecond-secret-line\nthird\n");

    const page = await read(harness, { path: "secret.txt", offset: 2, limit: 1 });
    expect(page.contentPreview).toBe("second-secret-line\n");

    const auditEvents = await harness.store.audit.listAuditEvents({
      clientInstanceId: harness.clientInstanceId,
      limit: 20
    });
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "operation.completed",
          metadata: expect.objectContaining({
            auditAction: "workspace.read_file",
            resultStatus: "success"
          })
        })
      ])
    );
    const audit = JSON.stringify(auditEvents);
    expect(audit).toContain("secret.txt");
    expect(audit).toContain('"startLine":2');
    expect(audit).toContain('"endLine":2');
    expect(audit).toContain('"totalLines":3');
    expect(audit).not.toContain("secret-line");

    const runs = await harness.execution.runs.list({ clientInstanceId: harness.clientInstanceId });
    expect(runs.length).toBeGreaterThan(0);
    expect(JSON.stringify(runs)).not.toContain("secret-line");
  });

  // Fails without the change: the description promised a "bounded preview" and no way on.
  it("describes how to continue, with the limits the tools enforce", async () => {
    const harness = await createWorkspaceHarness();
    const readTool = harness.tools.find((tool) => tool.name === "workspace.read_file");
    expect(readTool?.effect).toBe("reading");
    expect(readTool?.description).toContain("400 lines or 16 KiB");
    expect(readTool?.description).toContain("call again with offset set to nextOffset");
    expect(readTool?.description).toContain("above 8 MiB");
    expect(readTool?.description).toContain("workspace.exec");

    const listTool = harness.tools.find((tool) => tool.name === "workspace.list_files");
    expect(listTool?.effect).toBe("reading");
    expect(listTool?.description).toContain("empty until a tool has put a file there");
    expect(listTool?.description).toContain("workspace.read_file");
  });
});
