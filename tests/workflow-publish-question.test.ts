import { describe, expect, it } from "vitest";
import { createWorkflowAssetKind } from "@work-shape/catalyst-client-assembly";
import {
  INSTANCE_ASSET_SCOPE,
  asClientInstanceId,
  type LocaleCode,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { WORKFLOW_UNBOUNDED_CEILINGS } from "@work-shape/catalyst-workflows";

// REH-900: the publish question named notify recipients by raw user id, in English, to German
// staff. It is now written in the reader's language and names people and workspaces by name.

const untouched = () => Promise.reject(new Error("The publish question reads no asset or grant"));
const kind = createWorkflowAssetKind({
  clientInstanceId: asClientInstanceId("ci_test"),
  limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
  runnerPackages: [],
  configAssets: { getConfigAsset: untouched, listPublishedConfigAssets: untouched },
  apiAccess: { findServicePrincipalByName: untouched },
  access: { loadPersistedAccess: untouched, listGrantScopeAssets: untouched }
});

const PEOPLE = new Map([
  ["usr_mara", "Mara Lindqvist"],
  ["usr_jonas", "Jonas\nWeber"]
]);
const WORKSPACES = new Map([["cw_kanzlei", "Kanzlei"]]);
const names = {
  user: (id: string) => Promise.resolve(PEOPLE.get(id)),
  workspace: (id: string) => Promise.resolve(WORKSPACES.get(id))
};

function manifest(to: { users?: string[]; workspaces?: string[] }): WorkflowManifest {
  return {
    id: "monthly-check",
    name: "Monthly check",
    runAs: "check-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    limits: { duration: "24h" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "tell",
        name: "Tell the team",
        type: "notify",
        to,
        channels: ["inbox", "mail"],
        title: { value: "Findings" },
        text: { value: "Counts" }
      },
      { id: "end", name: "End", type: "output", input: {} }
    ]
  };
}

async function question(
  locale: LocaleCode,
  to: { users?: string[]; workspaces?: string[] } = {
    users: ["usr_mara", "usr_jonas"],
    workspaces: ["cw_kanzlei"]
  }
): Promise<string[]> {
  const ask = kind.publishQuestion;
  if (ask === undefined) throw new Error("The Workflow kind asks no publish question");
  return ask({
    assetId: "asset_1",
    scope: INSTANCE_ASSET_SCOPE,
    config: { name: "monthly-check", manifest: manifest(to) },
    locale,
    names
  });
}

describe("the publish question of a Workflow", () => {
  it("names whom a notify step reaches by name, never by id, in English", async () => {
    expect(await question("en")).toEqual([
      "Raises the run time of each run from 12h to 24h.",
      "“Tell the team” notifies Mara Lindqvist, Jonas Weber, and the workspace “Kanzlei”, in the Inbox and by mail. A mail carries counts and a link only."
    ]);
  });

  it("says the same in German for a German reader", async () => {
    expect(await question("de")).toEqual([
      "Erhöht die Laufzeit jedes Laufs von 12h auf 24h.",
      "„Tell the team“ benachrichtigt Mara Lindqvist, Jonas Weber und den Arbeitsbereich „Kanzlei“, im Eingang und per E-Mail. Eine E-Mail enthält nur Anzahlen und einen Link."
    ]);
  });

  it("says that an id names nobody any more, and still shows no id", async () => {
    const lines = (await question("en", { users: ["usr_gone"], workspaces: ["cw_gone"] })).join(
      "\n"
    );
    expect(lines).toContain("a person who no longer exists");
    expect(lines).toContain("a workspace that no longer exists");
    expect(lines).not.toMatch(/usr_|cw_/u);
  });

  it("keeps each line one line when a name holds a line break", async () => {
    for (const line of await question("de")) expect(line).not.toContain("\n");
  });
});
