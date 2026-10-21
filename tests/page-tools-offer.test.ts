import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformTools, platformModules } from "@work-shape/catalyst-client-assembly";
import { createModuleRegistry } from "@work-shape/catalyst-core";
import { createAppPublishTool } from "@work-shape/catalyst-tool-execution";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// Every agent builds an App: the conversation offers the open, the save and the file tools an
// App's folder is written with, whatever the agent's definition lists. Fails without A3: only
// an agent whose definition listed the open could build one, and no agent could save one.

const stand = (name: string) =>
  defineTool({
    name,
    effect: "reading",
    description: name,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: () => toolSuccess({})
  });

const PAGE_TOOLS = [
  "workspace.open",
  "app.save",
  "assets.publish",
  // DP-2: the agent tries the App's draft and reviews its publish.
  "apps.try_action",
  "apps.publish_review",
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.read_file"
];

async function offered(input: { apps: boolean; release: string[]; registered?: string[] }) {
  const harness = await createWorkspaceHarness();
  const modules = createModuleRegistry(platformModules).snapshot({
    apps: { enabled: input.apps }
  });
  const platform = createPlatformTools({ stores: harness.store, modules });
  const registered = input.registered ?? [
    "workspace.open",
    "workspace.write_file",
    "workspace.edit_file",
    "workspace.read_file",
    "workspace.exec"
  ];
  platform.registry([...registered.map(stand), ...platform.tools], new Set(input.release));
  const offer = await platform.conversationOffer.offerOf({
    clientInstanceId: harness.clientInstanceId,
    conversationId: harness.conversation.id,
    // An agent that lists none of the platform's tools: the App tools are no part of that gate.
    agentToolNames: []
  });
  return offer?.toolNames ?? [];
}

describe("the tools a conversation is offered to build an App", () => {
  it("offers the existing publish confirmation for a Workflow", () => {
    const tool = createAppPublishTool();
    expect(
      tool.inputSchema.safeParse({ kind: "workflow", name: "check-books", revision: 1 }).success
    ).toBe(true);
    expect(
      tool.inputSchema.safeParse({ kind: "connection", name: "books", revision: 1 }).success
    ).toBe(false);
  });

  it("are the open, the save and the file tools, without the release naming the two App tools", async () => {
    const names = await offered({
      apps: true,
      release: ["workspace.write_file", "workspace.edit_file", "workspace.read_file"]
    });

    expect(names).toEqual(expect.arrayContaining(PAGE_TOOLS));
    // A tool the release enables but no App needs stays the agent's definition's to list.
    expect(names).not.toContain("workspace.exec");
  });

  it("leave out a file tool the release turned off, and offer nothing where no folder can be written", async () => {
    expect(await offered({ apps: true, release: ["workspace.write_file"] })).toEqual(
      expect.arrayContaining(["workspace.open", "app.save", "workspace.write_file"])
    );
    expect(await offered({ apps: true, release: ["workspace.write_file"] })).not.toContain(
      "workspace.edit_file"
    );

    const withoutWrite = await offered({ apps: true, release: [] });
    expect(withoutWrite.filter((name) => PAGE_TOOLS.includes(name))).toEqual([]);
  });

  it("are none with the apps module off", async () => {
    const names = await offered({
      apps: false,
      release: ["workspace.open", "workspace.write_file", "workspace.edit_file"]
    });

    expect(names.filter((name) => PAGE_TOOLS.includes(name))).toEqual([]);
  });

  // Check 53 and 54 of apps-and-pages: only the new names are offered. Fails without OPEN-1:
  // the conversation offered page.save and page.save_as_app.
  it("offer no former name, also where the release still names one", async () => {
    const names = await offered({
      apps: true,
      release: ["page.save", "workspace.write_file"]
    });

    expect(names).toEqual(expect.arrayContaining(["workspace.open", "app.save"]));
    expect(names).not.toContain("page.save");
    expect(names).not.toContain("page.save_as_app");
  });
});
