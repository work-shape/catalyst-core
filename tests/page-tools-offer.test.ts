import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformTools, platformModules } from "@vivd-catalyst/client-assembly";
import { createModuleRegistry } from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// Every agent builds a Page: the conversation offers the save, the step to an App and the file
// tools a Page's folder is written with, whatever the agent's definition lists. Fails without
// the change: only an agent whose definition listed `page.save` could build a Page, and no
// agent could make one an App.

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
  "page.save",
  "page.save_as_app",
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
    "page.save",
    "workspace.write_file",
    "workspace.edit_file",
    "workspace.read_file",
    "workspace.exec"
  ];
  platform.registry([...registered.map(stand), ...platform.tools], new Set(input.release));
  const offer = await platform.conversationOffer.offerOf({
    clientInstanceId: harness.clientInstanceId,
    conversationId: harness.conversation.id,
    // An agent that lists none of the platform's tools: the Page tools are no part of that gate.
    agentToolNames: []
  });
  return offer?.toolNames ?? [];
}

describe("the tools a conversation is offered to build a Page", () => {
  it("are the save, the step to an App and the file tools, without the release naming the two Page tools", async () => {
    const names = await offered({
      apps: true,
      release: ["workspace.write_file", "workspace.edit_file", "workspace.read_file"]
    });

    expect(names).toEqual(expect.arrayContaining(PAGE_TOOLS));
    // A tool the release enables but no Page needs stays the agent's definition's to list.
    expect(names).not.toContain("workspace.exec");
  });

  it("leave out a file tool the release turned off, and offer nothing where no folder can be written", async () => {
    expect(await offered({ apps: true, release: ["workspace.write_file"] })).toEqual(
      expect.arrayContaining(["page.save", "page.save_as_app", "workspace.write_file"])
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
      release: ["page.save", "workspace.write_file", "workspace.edit_file"]
    });

    expect(names.filter((name) => PAGE_TOOLS.includes(name))).toEqual([]);
  });
});
