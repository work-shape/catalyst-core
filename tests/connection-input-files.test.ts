import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ConnectionCallSlots,
  buildConnectionCatalog,
  callConnectionOperation,
  openConnectorContext,
  readConnection
} from "@work-shape/catalyst-connections";
import {
  AppError,
  CONNECTION_INPUT_FILE_MAX_BYTES,
  asConversationId,
  asManagedFileId,
  createPlatformId,
  asUserId,
  connectionCallReasonOf,
  createConnectorTypeRegistry,
  findConnectorTypeIssues,
  type WorkflowRunPrincipal,
  type ConnectionConfig,
  type ConnectionConversationFiles,
  type ConnectorOperationDescriptor,
  type ConnectorTypeDefinition,
  type EgressGrant,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import { createConnectionConversationFiles } from "@work-shape/catalyst-client-assembly";
import { required } from "./support/assertions";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";
import {
  agentOrigin,
  fixtureOn,
  identityOf,
  operationOf,
  type ConnectionOperationsFixture
} from "./support/connection-operations";
import { asMember, useKnowledgeFiles } from "./support/knowledge-files";

// An operation's input may name a file of the calling conversation. The platform decides whether
// the caller may open it; the Connector type only ever receives a bounded reader.

const filing: ConnectorOperationDescriptor = {
  name: "file_it",
  description: "Files a conversation file.",
  inputSchema: {
    type: "object",
    properties: { fileId: { type: "string" } },
    required: ["fileId"],
    additionalProperties: false
  },
  proposedEffect: "changing",
  conversationFileFields: ["fileId"]
};
const BYTES = new TextEncoder().encode("the file's bytes");

async function refusal(work: Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await work.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  if (!(error instanceof AppError)) throw new Error(`no refusal: ${String(error)}`);
  return connectionCallReasonOf(error);
}

async function setup() {
  const t = await fixtureOn(setupAccessInstance, { catalog: [filing] });
  await t.seed("crm", { operations: [operationOf("file_it", { effect: "changing" })] });
  return t;
}

async function direct(
  t: ConnectionOperationsFixture,
  files: ConnectionConversationFiles | undefined,
  origin = agentOrigin("connection.crm.file_it")
) {
  const stored = required(await readConnection(t.sourceDeps, "crm"));
  t.sequence.length = 0;
  t.executed.length = 0;
  return callConnectionOperation(
    { ...t.sourceDeps, ...(files ? { conversationFiles: files } : {}) },
    new ConnectionCallSlots(),
    {
      connectionName: "crm",
      operationName: "file_it",
      assetId: stored.assetId,
      revision: stored.revision
    },
    { fileId: "file_1" },
    { runtime: {}, actor: identityOf(t.kai), origin }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a conversation file as an operation's input", () => {
  it("hands the type a reader and keeps the bytes out of the input and the result", async () => {
    const t = await setup();
    const asked: unknown[] = [];
    let read: Uint8Array | undefined;
    t.setBehaviour(async (_operation, input, context) => {
      read = await context.inputFiles?.fileId?.read();
      return { input, size: context.inputFiles?.fileId?.byteSize ?? 0 };
    });
    const answer = await direct(t, {
      open: (_actor, ref) => {
        asked.push(ref);
        return Promise.resolve({ byteSize: BYTES.byteLength, read: () => Promise.resolve(BYTES) });
      }
    });
    expect(read).toEqual(BYTES);
    expect(asked).toEqual([{ conversationId: "conv_test", fileId: "file_1" }]);
    expect(answer).toEqual({ input: { fileId: "file_1" }, size: BYTES.byteLength });
    expect(JSON.stringify(t.executed)).not.toContain("the file's bytes");
  });

  it("refuses a file the caller cannot open before anything outside is contacted", async () => {
    const t = await setup();
    expect(await refusal(direct(t, { open: () => Promise.resolve(undefined) }))).toBe(
      "input_file_unavailable"
    );
    expect(t.executed).toEqual([]);
    expect(t.sequence).not.toContain("check egress");
    expect(t.sequence).not.toContain("resolve credential");
  });

  it("refuses without a file port, and from any origin but an agent's conversation", async () => {
    const t = await setup();
    const open = vi.fn(() =>
      Promise.resolve({ byteSize: 1, read: () => Promise.resolve(new Uint8Array(1)) })
    );
    expect(await refusal(direct(t, undefined))).toBe("input_file_unavailable");
    expect(await refusal(direct(t, { open }, { kind: "user" }))).toBe("input_file_unavailable");
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a file over 25 MiB by its record and again by what is read", async () => {
    const t = await setup();
    const tooLarge = CONNECTION_INPUT_FILE_MAX_BYTES + 1;
    expect(
      await refusal(
        direct(t, {
          open: () =>
            Promise.resolve({ byteSize: tooLarge, read: () => Promise.reject(new Error("no")) })
        })
      )
    ).toBe("input_file_too_large");
    expect(t.executed).toEqual([]);

    t.setBehaviour(async (_operation, _input, context) => {
      await context.inputFiles?.fileId?.read();
      return {};
    });
    expect(
      await refusal(
        direct(t, {
          open: () =>
            Promise.resolve({
              byteSize: 1,
              read: () => Promise.resolve(new Uint8Array(tooLarge))
            })
        })
      )
    ).toBe("input_file_too_large");
  });

  it("never reads a mark from a catalog an outside system described", () => {
    const catalog = buildConnectionCatalog({
      discovered: [filing],
      accepted: [],
      previous: undefined,
      now: "2026-11-23T00:00:00.000Z"
    });
    expect(catalog.entries[0]).not.toHaveProperty("conversationFileFields");
  });
});

describe("which conversation file a person may open", () => {
  const { instanceWithFiles, conversationWithFile } = useKnowledgeFiles();
  const file = { filename: "scan.txt", contentType: "text/plain", content: "scan" };

  it("opens a file of the person's chat, from a subagent's thread too, and no other", async () => {
    const { instance } = await instanceWithFiles();
    const own = await conversationWithFile(instance, file, asMember);
    const other = await conversationWithFile(instance, file);
    const root = required(
      await instance.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(own.conversationId)
      )
    );
    const actor = await ownerOf(instance, root.createdByUserId);
    const threadId = "conv_thread";
    const stores = {
      ...instance.stores,
      conversations: new Proxy(instance.stores.conversations, {
        get(target, property) {
          if (property !== "getConversation") return Reflect.get(target, property) as unknown;
          return (scope: typeof clientInstanceId, id: string) =>
            id === threadId
              ? Promise.resolve({ ...root, id, kind: "run_thread", parentConversationId: root.id })
              : target.getConversation(scope, asConversationId(id));
        }
      })
    };
    const files = createConnectionConversationFiles({
      clientInstanceId,
      stores,
      attachments: {
        readConversationFile: (input) =>
          Promise.resolve({
            fileId: asManagedFileId(input.fileId),
            filename: "scan.txt",
            byteSize: 4,
            bytes: new TextEncoder().encode("scan")
          })
      }
    });

    const opened = await files.open(actor, own);
    expect(opened?.byteSize).toBe(4);
    expect(new TextDecoder().decode(await opened?.read())).toBe("scan");
    expect(
      (await files.open(actor, { conversationId: threadId, fileId: own.fileId }))?.byteSize
    ).toBe(4);
    // Another person's chat, and a file that belongs to another chat.
    expect(await files.open(actor, other)).toBeUndefined();
    expect(
      await files.open(actor, { conversationId: own.conversationId, fileId: other.fileId })
    ).toBeUndefined();
    expect(await files.open(service, own)).toBeUndefined();
  });

  it("opens a file of the chat's workspace by its path, for whom may open the chat", async () => {
    const { instance } = await instanceWithFiles();
    const own = await conversationWithFile(instance, file, asMember);
    const other = await conversationWithFile(instance, file);
    const root = required(
      await instance.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(own.conversationId)
      )
    );
    const actor = await ownerOf(instance, root.createdByUserId);
    const deck = "outputs/deck.pptx";
    const openFile = vi.fn(({ path }: { path: string }) =>
      Promise.resolve(
        path === deck ? { byteSize: 7, read: () => Promise.resolve(BYTES) } : undefined
      )
    );
    const files = createConnectionConversationFiles({
      clientInstanceId,
      stores: instance.stores,
      attachments: {
        readConversationFile: (input) =>
          Promise.resolve({
            fileId: asManagedFileId(input.fileId),
            filename: "scan.txt",
            byteSize: 4,
            bytes: new TextEncoder().encode("scan")
          })
      },
      workspace: { openFile }
    });

    expect(
      (await files.open(actor, { conversationId: own.conversationId, fileId: deck }))?.byteSize
    ).toBe(7);
    // An attachment's fileId is the attachment, never looked up in the workspace.
    expect((await files.open(actor, own))?.byteSize).toBe(4);
    expect(openFile).toHaveBeenCalledTimes(1);
    // Another person's chat, and a path the workspace does not hold.
    expect(
      await files.open(actor, { conversationId: other.conversationId, fileId: deck })
    ).toBeUndefined();
    expect(
      await files.open(actor, { conversationId: own.conversationId, fileId: "outputs/none.pdf" })
    ).toBeUndefined();
    expect(openFile).toHaveBeenCalledTimes(2);
    // A Workflow's agent reaches the workspace of its own thread, as its workspace tools do.
    expect(
      (await files.open(service, { conversationId: own.conversationId, fileId: deck }))?.byteSize
    ).toBe(7);
  });
});

const service: WorkflowRunPrincipal = {
  kind: "service",
  id: createPlatformId<"ServicePrincipalId">("svc"),
  displayLabel: "A service",
  permissionRefs: [],
  permissions: [],
  clientInstanceId,
  authSource: "workflow_run",
  scopes: ["*"],
  workflowRunId: createPlatformId<"WorkflowRunId">("wfr")
};

async function ownerOf(
  instance: Awaited<
    ReturnType<ReturnType<typeof useKnowledgeFiles>["instanceWithFiles"]>
  >["instance"],
  userId: string | undefined
) {
  const owner = required(
    await instance.stores.users.getUser({ clientInstanceId, userId: asUserId(required(userId)) })
  );
  return identityOf(owner);
}

describe("what a type may say about its credential and its operations", () => {
  const grant = (host: string): EgressGrant => ({
    protocol: "https",
    host,
    port: 443,
    address: "93.184.216.34",
    family: 4,
    network: "public"
  });
  const type = (
    further: Partial<
      Pick<
        ConnectorTypeDefinition,
        "credentialTargets" | "operationRefusal" | "personalSignIn" | "authSchemes"
      >
    > = {}
  ): ConnectorTypeDefinition => ({
    type: "two_hosts",
    description: "Two hosts.",
    settingsSchema: z.custom<JsonObject>(() => true),
    authSchemes: ["bearer"],
    secretFields: ["token"],
    catalog: [filing],
    target: () => ({ protocol: "https", host: "api.example.com", port: 443 }),
    test: () => Promise.resolve({ status: "ready" }),
    execute: () => Promise.resolve(null as JsonValue),
    limits: { callTimeoutMs: 1_000, resultMaxBytes: 1_024, maxParallelCalls: 1 },
    ...further
  });
  const open = (definition: ConnectorTypeDefinition, test?: { secretHandle: string }) =>
    openConnectorContext({
      type: definition,
      connection: {
        id: "asset",
        revision: 1,
        config: {
          name: "two",
          displayName: "Two hosts",
          connectorType: "two_hosts",
          ownerPrincipalId: "user_admin",
          credentialMode: "shared",
          authScheme: "bearer",
          settings: {},
          secretHandle: "secret_handle",
          operations: [],
          enabled: true,
          origin: "runtime"
        } satisfies ConnectionConfig
      },
      egress: {
        check: (target) => Promise.resolve(grant(target.host)),
        admits: () => true,
        refusal: () => undefined
      },
      credentials: {
        resolve: () => Promise.resolve("token-value"),
        resolveSignIn: () => Promise.resolve("token-value")
      },
      signal: new AbortController().signal,
      ...(test ? { test } : {})
    });
  const contentHost = {
    credentialTargets: () => [
      { protocol: "https" as const, host: "content.example.com", port: 443 }
    ]
  } as Partial<ConnectorTypeDefinition>;

  it("sends the credential to an origin the type's code names, and to no other", async () => {
    const context = await open(type(contentHost));
    expect(context.credentialFor(grant("content.example.com"))?.secret).toBe("token-value");
    expect(() => context.credentialFor(grant("elsewhere.example.com"))).toThrow(/egress_denied/u);
    const plain = await open(type());
    expect(() => plain.credentialFor(grant("content.example.com"))).toThrow(/egress_denied/u);
  });

  it("keeps a test credential off a further origin", async () => {
    const context = await open(type(contentHost), { secretHandle: "secret_test" });
    expect(() => context.credentialFor(grant("content.example.com"))).toThrow(/egress_denied/u);
  });

  it("refuses to save an operation the type says these settings cannot use", () => {
    const registry = createConnectorTypeRegistry([
      type({
        operationRefusal: (name) => (name === "file_it" ? "This sign-in is read-only" : undefined)
      })
    ]);
    const issues = findConnectorTypeIssues(registry, {
      connectorType: "two_hosts",
      settings: {},
      authScheme: "bearer",
      credentialMode: "shared",
      operations: [{ name: "file_it", effect: "changing", exposure: ["agent"], enabled: true }]
    });
    expect(issues).toEqual([
      { message: "This sign-in is read-only", path: ["operations", 0, "name"] }
    ]);
  });

  it("takes a personal sign-in only on a type that declares it, and tells the refusal the mode", () => {
    const modes: string[] = [];
    const personal = (personalSignIn?: true) =>
      findConnectorTypeIssues(
        createConnectorTypeRegistry([
          type({
            authSchemes: ["oauth"],
            ...(personalSignIn ? { personalSignIn } : {}),
            operationRefusal: (_name, _settings, mode) => {
              modes.push(mode);
              return undefined;
            }
          })
        ]),
        {
          connectorType: "two_hosts",
          settings: {},
          authScheme: "oauth",
          credentialMode: "user",
          operations: [{ name: "file_it", effect: "changing", exposure: ["agent"], enabled: true }]
        }
      );
    expect(personal()).toMatchObject([
      { message: expect.stringMatching(/^personal_oauth_required/u), path: ["credentialMode"] }
    ]);
    expect(personal(true)).toEqual([]);
    expect(modes).toEqual(["user", "user"]);
  });
});
