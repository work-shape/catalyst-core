import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createWorkflowAssetKind } from "@work-shape/catalyst-client-assembly";
import {
  INSTANCE_ASSET_SCOPE,
  asClientInstanceId,
  type LocaleCode,
  type OperationDefinition,
  type WorkflowManifest,
  type WorkflowNeededRight
} from "@work-shape/catalyst-core";
import {
  WORKFLOW_UNBOUNDED_CEILINGS,
  type WorkflowLimitContext
} from "@work-shape/catalyst-workflows";

// REH-900: the publish question named notify recipients by raw user id, in English, to German
// staff. It is now written in the reader's language and names people and workspaces by name.

const untouched = () => Promise.reject(new Error("The publish question reads no asset or grant"));
const kindOptions = {
  clientInstanceId: asClientInstanceId("ci_test"),
  limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
  runnerPackages: [],
  configAssets: { getConfigAsset: untouched, listPublishedConfigAssets: untouched },
  apiAccess: { findServicePrincipalByName: untouched, findServicePrincipalByOwner: untouched },
  access: { loadPersistedAccess: untouched, listGrantScopeAssets: untouched }
};
const kind = createWorkflowAssetKind(kindOptions);

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

/** Exercise the kind's public question with operations exposing the rights of these steps. */
async function workflowPublishQuestion(input: {
  manifest: WorkflowManifest;
  limits: WorkflowLimitContext;
  locale: LocaleCode;
  names: Parameters<NonNullable<typeof kind.publishQuestion>>[0]["names"];
  rights?: readonly WorkflowNeededRight[];
}): Promise<string[]> {
  const operations: OperationDefinition[] = (input.rights ?? []).map((right, index) => ({
    name: `test.right_${index}`,
    effect: "reading",
    auth: "principal",
    scope: null,
    action: right.action,
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    timeoutMs: 1000,
    resource: () => ({
      kind: right.asset.kind,
      id: right.asset.assetId ?? right.asset.name,
      name: right.asset.name,
      assetId: right.asset.assetId
    }),
    execute: untouched
  }));
  const definition: WorkflowManifest = {
    ...input.manifest,
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...operations.map((operation, index) => ({
        id: `right_${index}`,
        name: "Step",
        type: "operation" as const,
        input: {},
        operation: operation.name
      })),
      { id: "end", name: "End", type: "output", input: {} }
    ]
  };
  const testKind = createWorkflowAssetKind({
    ...kindOptions,
    limits: input.limits,
    registry: () => ({
      resolve: (name) => Promise.resolve(operations.find((operation) => operation.name === name)),
      resolveMany: (names) =>
        Promise.resolve(
          new Map(
            operations
              .filter((operation) => names.includes(operation.name))
              .map((operation) => [operation.name, operation])
          )
        )
    })
  });
  const ask = testKind.publishQuestion;
  if (!ask) throw new Error("missing publish question");
  return ask({
    assetId: "asset_1",
    scope: INSTANCE_ASSET_SCOPE,
    config: { name: definition.id, manifest: definition },
    locale: input.locale,
    names: input.names
  });
}

// LIVE-1: a definition without `runAs` runs as its own account, which gets the rights its steps
// need. The question names that account once, with what it may do, by asset names only.
describe("the publish question of a Workflow that runs as its own account", () => {
  const right = (action: string, kind: string, name: string): WorkflowNeededRight => ({
    action,
    asset: { kind, name, assetId: `asset_${name}`, workspaceId: "cw_secret" },
    steps: ["read"],
    neededFor: "run"
  });
  const RIGHTS = [
    right("connection.use", "connection", "Exampledata"),
    right("data_store.insert", "data_store", "Findings"),
    right("knowledge_base.use", "knowledge_base", "Handbook"),
    right("data_store.execute", "data_store", "Open items"),
    right("workflow.use", "workflow", "Check\nmonth")
  ];
  const own = (runAs?: string): WorkflowManifest => ({
    id: "monthly-check",
    name: "Monthly\ncheck",
    ...(runAs === undefined ? {} : { runAs }),
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "end", name: "End", type: "output", input: {} }
    ]
  });
  const ask = (
    locale: LocaleCode,
    rights: readonly WorkflowNeededRight[] | undefined,
    runAs?: string
  ) =>
    workflowPublishQuestion({
      manifest: own(runAs),
      limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
      locale,
      names,
      ...(rights === undefined ? {} : { rights })
    });

  it("names each asset by the title the reader may be told, never by its machine name", async () => {
    const titled = {
      ...names,
      asset: (kind: string, name: string) =>
        Promise.resolve(
          kind === "connection" && name === "exampledata-machine"
            ? "Exampledata"
            : kind === "data_store" && name === "findings-machine"
              ? "Findings\nof the month"
              : undefined
        )
    };
    const lines = await workflowPublishQuestion({
      manifest: own(),
      limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
      locale: "en",
      names: titled,
      rights: [
        right("connection.use", "connection", "exampledata-machine"),
        right("data_store.insert", "data_store", "findings-machine"),
        // A title the reader may not be told: the definition's name stands.
        right("knowledge_base.use", "knowledge_base", "handbook")
      ]
    });
    expect(lines).toEqual([
      "Runs as its own account “Monthly check” and may use Exampledata and handbook and add rows to Findings of the month."
    ]);
    expect(lines.join("\n")).not.toMatch(/-machine|asset_|cw_/u);
  });

  it("names the account and what it may do, in English", async () => {
    expect(await ask("en", RIGHTS.slice(0, 2))).toEqual([
      "Runs as its own account “Monthly check” and may use Exampledata and add rows to Findings."
    ]);
  });

  it("says the same in German for a German reader", async () => {
    expect(await ask("de", RIGHTS.slice(0, 2))).toEqual([
      "Läuft unter einem eigenen Konto „Monthly check“ und darf Exampledata nutzen und Datensätze zu Findings hinzufügen."
    ]);
  });

  it("groups the assets one kind of right reaches and words each right", async () => {
    expect(await ask("en", RIGHTS)).toEqual([
      "Runs as its own account “Monthly check” and may use Exampledata and Handbook, add rows to Findings, change and delete rows in Open items, and start the workflow “Check month”."
    ]);
  });

  it("says the account may put documents into a Knowledge Base and read one (KBW-3)", async () => {
    const rights = [
      right("knowledge_base.ingest", "knowledge_base", "Property files"),
      right("knowledge_base.read", "knowledge_base", "Contracts")
    ];
    expect(await ask("en", rights)).toEqual([
      "Runs as its own account “Monthly check” and may put documents into Property files and read Contracts."
    ]);
    expect(await ask("de", rights)).toEqual([
      "Läuft unter einem eigenen Konto „Monthly check“ und darf Dokumente in Property files einspielen und Contracts lesen."
    ]);
  });

  it("words an action named like an Object property as using, and shows no code", async () => {
    for (const action of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const lines = await ask("en", [right(action, "connection", "Exampledata")]);
      expect(lines, action).toEqual([
        "Runs as its own account “Monthly check” and may use Exampledata."
      ]);
    }
  });

  it("names the account alone where its steps need no right", async () => {
    expect(await ask("en", [])).toEqual(["Runs as its own account “Monthly check”."]);
    expect(await ask("de", undefined)).toEqual([
      "Läuft unter einem eigenen Konto „Monthly check“."
    ]);
  });

  it("shows no id, workspace or step of a right", async () => {
    const lines = (await ask("en", RIGHTS)).join("\n");
    expect(lines).not.toMatch(/asset_|cw_|connection\.use|read/u);
  });

  it("says nothing of an account a definition names under runAs", async () => {
    expect(await ask("en", RIGHTS, "shared-runner")).toEqual([]);
  });
});
