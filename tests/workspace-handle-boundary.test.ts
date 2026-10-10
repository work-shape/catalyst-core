import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const TOOL_REQUEST_CONVERSATION_READ = /\btoolRequest\s*(?:\?\s*)?\.\s*conversationId\b/u;
const TOOL_REQUEST_CONVERSATION_DESTRUCTURE =
  /\{[^{}]*\bconversationId\b[^{}]*\}\s*(?::[^=;]+)?=\s*[^;]*?\btoolRequest\b/u;

function readsToolRequestConversation(source: string): boolean {
  return (
    TOOL_REQUEST_CONVERSATION_READ.test(source) ||
    TOOL_REQUEST_CONVERSATION_DESTRUCTURE.test(source)
  );
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typescriptFiles(file);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [file] : [];
  });
}

const sourceDirectory = join(process.cwd(), "packages/tool-execution/src");

/** Every file that addresses a workspace: the workspace tools and the tool that saves a Page. */
function workspaceAddressingFiles(): string[] {
  return [
    ...typescriptFiles(join(sourceDirectory, "workspace-tools")),
    ...readdirSync(sourceDirectory)
      .filter((name) => /^(?:workspace|page)-.*\.ts$/u.test(name))
      .map((name) => join(sourceDirectory, name))
  ];
}

// The only lines of these files that may name the tool request. A read through an alias or a
// destructured name passes the patterns above, so any other mention fails here.
const TOOL_REQUEST_MENTIONS: Record<string, string[]> = {
  "workspace-tools/workspace-handle-resolver.ts": [
    "const conversationId = context.toolRequest?.conversationId;"
  ],
  "workspace-tools/exec.ts": [
    "agentRunId: context.toolRequest?.agentRunId,",
    "toolCallId: context.toolRequest?.toolCallId,"
  ],
  "workspace-preview-images.ts": ["if (!context.toolRequest) {"]
};

function toolRequestMentions(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /toolRequest/u.test(line))
    .map((line) => line.trim());
}

describe("the workspace handle boundary", () => {
  it("covers the tool that saves a Page", () => {
    expect(workspaceAddressingFiles().map((file) => relative(sourceDirectory, file))).toContain(
      "page-save-tool.ts"
    );
  });

  it("names the tool request only on the listed lines", () => {
    const mentions = Object.fromEntries(
      workspaceAddressingFiles()
        .map((file): [string, string[]] => [
          relative(sourceDirectory, file),
          toolRequestMentions(readFileSync(file, "utf8"))
        ])
        .filter(([, lines]) => lines.length > 0)
    );

    expect(mentions).toEqual(TOOL_REQUEST_MENTIONS);
  });

  it.each([
    "const request = context.toolRequest;",
    "const { toolRequest } = context;",
    "const { toolRequest: request } = context;"
  ])("counts the alias in %s as a mention", (source) => {
    expect(toolRequestMentions(source)).toEqual([source]);
  });

  it("reads the tool request's conversation only in the handle resolver", () => {
    const files = workspaceAddressingFiles();
    const readers = files
      .filter((file) => readsToolRequestConversation(readFileSync(file, "utf8")))
      .map((file) => relative(sourceDirectory, file));

    expect(readers.sort()).toEqual(["workspace-tools/workspace-handle-resolver.ts"]);
  });

  it.each([
    "context.toolRequest.conversationId",
    "context.toolRequest?.conversationId",
    "context.toolRequest ?. conversationId",
    "const { conversationId } = context.toolRequest;",
    "const { conversationId: attribution, toolCallId } = context.toolRequest;",
    "const { conversationId } =\n  context.toolRequest ?? {};",
    "({ conversationId } = context.toolRequest);"
  ])("detects a conversation read in %s", (source) => {
    expect(readsToolRequestConversation(source)).toBe(true);
  });
});
