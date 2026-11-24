import { describe, expect, it } from "vitest";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  agentConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig,
  type SafeConfigKnowledgeBase
} from "@work-shape/catalyst-config-schema";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  type AccessResource,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { agentKnowledgeBases } from "@work-shape/catalyst-server";

// The empty chat names the Knowledge Bases an agent answers from, so a person sees what it
// knows before asking. An agent list tells the id, the name people read and a short
// description of those the reader may read, and nothing else of a Knowledge Base.

const given: SafeConfigKnowledgeBase[] = [
  { name: "handbook", title: "Product handbook", description: "Every product and its options." },
  { name: "prices", title: "Price list" },
  { name: "contracts", title: "Contracts", description: "Signed contracts." }
];

function view(knowledgeBases: string[] | undefined, readable?: SafeConfigKnowledgeBase[]) {
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: { id: "knowledge-test", displayName: "Test", environment: "development" },
    auth: { development: { enabled: true, user: { permissionRefs: [] } } },
    localization: { defaultLocale: "en", supportedLocales: ["en", "de"] },
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
  });
  const assets = {
    version: 1,
    defaultAgentName: "agent",
    agents: [
      agentConfigSchema.parse({
        name: "agent",
        displayName: "Agent",
        instructions: "Help.",
        ...(knowledgeBases === undefined ? {} : { knowledgeBases })
      })
    ],
    skills: []
  };
  return createSafeConfigView(config, assets, resolveInstanceModules(config, []).snapshot, {
    requestedLocale: "en",
    ...(readable === undefined ? {} : { knowledgeBases: readable })
  });
}

describe("the Knowledge Bases an agent list names", () => {
  it("names those the agent answers from, in the agent's order", () => {
    const safe = view(["prices", "handbook"], given);
    expect(safe.agents[0]?.knowledgeBases).toEqual([
      { name: "prices", title: "Price list" },
      { name: "handbook", title: "Product handbook", description: "Every product and its options." }
    ]);
    expect(safeConfigSchema.safeParse(safe).success).toBe(true);
  });

  it("leaves out one the reader was not given, and names none unasked", () => {
    const readable = given.filter((knowledgeBase) => knowledgeBase.name !== "contracts");
    expect(
      view(["handbook", "contracts"], readable).agents[0]?.knowledgeBases?.map(({ name }) => name)
    ).toEqual(["handbook"]);
    expect(view(["handbook"]).agents[0]?.knowledgeBases).toEqual([]);
    expect(view(undefined, given).agents[0]?.knowledgeBases).toEqual([]);
  });

  it("tells the id, the title and a short description and nothing else", () => {
    const long = `${"A long description for the agent. ".repeat(40)}The end.`;
    const stored = {
      name: "handbook",
      title: "Product handbook",
      description: long,
      backend: { kind: "builtin" },
      tables: [{ name: "secret_table", description: "Not for the start page." }]
    };
    const safe = view(["handbook"], [stored]);
    const told = safe.agents[0]?.knowledgeBases ?? [];

    expect(told.map((knowledgeBase) => Object.keys(knowledgeBase).sort())).toEqual([
      ["description", "name", "title"]
    ]);
    expect(told[0]?.description?.length).toBeLessThanOrEqual(240);
    expect(told[0]?.description?.endsWith("…")).toBe(true);
    expect(JSON.stringify(safe)).not.toContain("secret_table");
    expect(JSON.stringify(safe)).not.toContain("builtin");
    // The contract holds the same bound: it names these fields and no other.
    const agentShape = safeConfigSchema.shape.agents.element.shape;
    expect(Object.keys(agentShape.knowledgeBases.unwrap().element.shape).sort()).toEqual([
      "description",
      "name",
      "title"
    ]);
  });
});

function record(
  name: string,
  extra: Partial<Pick<ConfigAssetRecord, "status" | "scope" | "publishedConfig">> = {}
): ConfigAssetRecord {
  return {
    id: `asset-${name}`,
    clientInstanceId: asClientInstanceId("instance"),
    kind: "knowledge_base",
    name,
    scope: { kind: "instance" },
    status: "active",
    activeRevisionId: "revision-1",
    revision: 1,
    config: null,
    publishedConfig: { title: `Title of ${name}`, description: `About ${name}.` },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra
  };
}

function readerOf(records: ConfigAssetRecord[], allowed: Record<string, string[]>, enabled = true) {
  const reads: string[] = [];
  const asked: (AccessResource | undefined)[] = [];
  const read = () =>
    agentKnowledgeBases(
      {
        clientInstanceId: asClientInstanceId("instance"),
        modules: { isEnabled: (name) => name === "knowledge" && enabled },
        configAssets: {
          store: {
            listPublishedConfigAssets: ({ kind }) => {
              reads.push(kind);
              return Promise.resolve(records);
            }
          }
        }
      },
      {
        authorize: (action, resource) => {
          asked.push(resource);
          return { allowed: (allowed[resource?.name ?? ""] ?? []).includes(action) };
        }
      }
    );
  return { reads, asked, read };
}

describe("the Knowledge Bases a person is told of", () => {
  it("are the published ones the person may read or search", async () => {
    const { read, reads } = readerOf(
      [
        record("handbook"),
        record("prices"),
        record("contracts"),
        record("gone", { status: "deleted" }),
        record("bare", { publishedConfig: {} })
      ],
      {
        handbook: ["knowledge_base.read"],
        prices: ["knowledge_base.use"],
        contracts: ["knowledge_base.write"],
        gone: ["knowledge_base.read"],
        bare: ["knowledge_base.read"]
      }
    );
    expect(await read()).toEqual([
      { name: "handbook", title: "Title of handbook", description: "About handbook." },
      { name: "prices", title: "Title of prices", description: "About prices." },
      // Without a title of its own, the id stands; without a description, none.
      { name: "bare", title: "bare" }
    ]);
    expect(reads).toEqual(["knowledge_base"]);
  });

  it("asks the right on the workspace that owns the Knowledge Base", async () => {
    const { read, asked } = readerOf(
      [
        record("team", {
          scope: { kind: "workspace", workspaceId: asCollaborationWorkspaceId("ws-1") }
        })
      ],
      {}
    );
    expect(await read()).toEqual([]);
    expect(asked[0]).toEqual({
      kind: "knowledge_base",
      name: "team",
      assetId: "asset-team",
      workspaceId: "ws-1"
    });
  });

  it("are none where the module is off, and nothing is read", async () => {
    const { reads, read } = readerOf(
      [record("handbook")],
      { handbook: ["knowledge_base.read"] },
      false
    );
    expect(await read()).toEqual([]);
    expect(reads).toEqual([]);
  });
});
