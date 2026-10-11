import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// What an agent reads when `workspace.apply_patch` refuses a patch that does not fit the file.
//
// Fails without the change: the refusal named a line number and neither showed the line the
// file has there nor said what to do next.

type Harness = Awaited<ReturnType<typeof createWorkspaceHarness>>;

const failureSchema = z.object({
  status: z.literal("failed"),
  error: z.object({
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

async function refusal(harness: Harness, toolName: string, input: unknown) {
  return failureSchema.parse(await harness.runTool(toolName, input)).error;
}

describe("a refused workspace.apply_patch", () => {
  it("shows the line the file has where the context differs, and says to read the file again", async () => {
    const harness = await createWorkspaceHarness();
    await harness.putWorkspaceFile({
      path: "notes.txt",
      objectKey: "workspace/notes.txt",
      bytes: "one\n\ttwo  \nthree\n",
      mimeType: "text/plain"
    });

    const mismatch = await refusal(harness, "workspace.apply_patch", {
      patch: ["--- a/notes.txt", "+++ b/notes.txt", "@@ -1,2 +1,2 @@", " one", "-two", "+2"].join(
        "\n"
      )
    });

    expect(mismatch.message).toContain(
      "context did not match file content at line 2 of 'notes.txt'"
    );
    // Quoted, so that the tab and the blanks at the end can be seen.
    expect(mismatch.message).toContain('The file has "\\ttwo  " there.');
    expect(mismatch.message).toContain("Read the file again with workspace.read_file");
    expect(mismatch.message).toContain("rebuild the patch");
    expect(mismatch.details).toMatchObject({ path: "notes.txt", line: 2, fileLineCount: 3 });

    const pastEnd = await refusal(harness, "workspace.apply_patch", {
      patch: [
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -3,2 +3,2 @@",
        " three",
        "-four",
        "+4"
      ].join("\n")
    });
    expect(pastEnd.message).toContain("at line 4 of 'notes.txt'. The file ends at line 3.");

    const wrongStart = await refusal(harness, "workspace.apply_patch", {
      patch: ["--- a/notes.txt", "+++ b/notes.txt", "@@ -9,1 +9,1 @@", "-x", "+y"].join("\n")
    });
    expect(wrongStart.message).toContain(
      "starts at line 9 of 'notes.txt', and the file has 3 lines"
    );
    expect(wrongStart.message).toContain("rebuild the patch");
    await expect(
      harness.runTool("workspace.read_file", { path: "notes.txt" })
    ).resolves.toMatchObject({ output: { contentPreview: "one\n\ttwo  \nthree\n" } });
  });
});
