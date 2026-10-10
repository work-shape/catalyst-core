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

describe("the workspace handle boundary", () => {
  it("reads the tool request's conversation only in the handle resolver", () => {
    const sourceDirectory = join(process.cwd(), "packages/tool-execution/src");
    const files = [
      ...typescriptFiles(join(sourceDirectory, "workspace-tools")),
      ...readdirSync(sourceDirectory)
        .filter((name) => /^workspace-.*\.ts$/u.test(name))
        .map((name) => join(sourceDirectory, name))
    ];
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
