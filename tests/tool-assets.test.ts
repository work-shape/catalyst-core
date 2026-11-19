import { afterAll, describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  createActorAccess,
  createPlatformId,
  dataToolPrefixOf,
  NoopAuditRecorder,
  TOOL_FILE_MAX_BYTES,
  TOOL_FILES_MAX,
  isToolOperationAnswer,
  toolAssetConfigSchema,
  toolCallOperationName,
  toolOfOperationName,
  type ConfigAssetRecord,
  type AuthenticatedUser,
  type ConfigAssetStore,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { findMissingAgentToolReferences } from "@work-shape/catalyst-config-schema";
import { createOutsideSchemaChecker } from "@work-shape/catalyst-connections";
import {
  TOOL_CODE_HTML_MAX_CHARS,
  TOOL_CODE_OUTPUT_MAX_BYTES,
  createToolAssetToolSource,
  createToolOperationSource,
  toolCodeCallAnswer
} from "@work-shape/catalyst-client-assembly";

// Tools an instance adds without a release (TOOL-1): the definition, the operation a published
// tool contributes, and the write check of its input schema. No database: the store is a map.

const clientInstanceId = asClientInstanceId("tool-assets");
const checker = createOutsideSchemaChecker();
afterAll(() => checker.close());

const definition = {
  name: "submit_review",
  type: "result",
  title: { en: "Submit review", de: "Prüfung abgeben" },
  description: "Call when the review is finished, with every finding.",
  input: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["complete", "incomplete"] },
      findings: { type: "array", items: { type: "string" } }
    },
    required: ["verdict"],
    additionalProperties: false
  },
  result: { kind: "review.document_check", title: "Review", reply: "Handed to the panel." }
} satisfies JsonObject;

function record(overrides: Partial<ConfigAssetRecord> = {}): ConfigAssetRecord {
  return {
    id: "asset-1",
    clientInstanceId,
    kind: "tool",
    name: definition.name,
    scope: { kind: "instance" },
    status: "active",
    activeRevisionId: "rev-2",
    revision: 2,
    config: definition,
    publishedRevisionId: "rev-1",
    publishedRevision: 1,
    publishedConfig: definition,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...overrides
  };
}

function storeOf(
  ...records: ConfigAssetRecord[]
): Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets"> {
  return {
    getConfigAsset: async ({ name }) => records.find((r) => r.name === name),
    listPublishedConfigAssets: async ({ names }) =>
      records.filter(
        (r) => r.publishedRevisionId !== undefined && (!names || names.includes(r.name))
      )
  };
}

const operationName = toolCallOperationName(definition.name);

async function resolved(...records: ConfigAssetRecord[]): Promise<OperationDefinition> {
  const source = createToolOperationSource({
    clientInstanceId,
    store: storeOf(...records),
    checker
  });
  const found = await source.resolve(operationName);
  if (!found) throw new Error("The tool did not resolve");
  return found;
}

const agentOrigin: Extract<OperationOrigin, { kind: "agent" }> = {
  kind: "agent",
  agentRunId: asAgentRunId("run-1"),
  conversationId: asConversationId("conv-1"),
  agentName: "reviewer",
  toolCallId: asToolCallId("call-1"),
  toolName: operationName
};
const actor: AuthenticatedUser = {
  clientInstanceId,
  id: "person",
  externalUserId: "person",
  displayLabel: "Person",
  authSource: "test",
  roles: [],
  permissionRefs: []
};
function contextOf(origin: OperationOrigin): OperationExecutionContext {
  return {
    runId: createPlatformId("opr"),
    actor,
    access: createActorAccess({ ...actor, kind: "user" }, { holderActive: true, grants: [] }),
    audit: new NoopAuditRecorder(),
    correlationId: "tool-assets",
    origin,
    runtime: {}
  };
}

describe("a tool's definition", () => {
  it("takes a result tool and refuses an input that is no object schema", () => {
    expect(toolAssetConfigSchema.safeParse(definition).success).toBe(true);
    expect(
      toolAssetConfigSchema.safeParse({ ...definition, input: { type: "string" } }).success
    ).toBe(false);
    expect(toolAssetConfigSchema.safeParse({ ...definition, type: "code" }).success).toBe(false);
    expect(toolAssetConfigSchema.safeParse({ ...definition, run: "echo" }).success).toBe(false);
    expect(toolAssetConfigSchema.safeParse({ ...definition, name: "Submit-Review" }).success).toBe(
      false
    );
  });

  it("takes a code tool whose handler is among its bounded files", () => {
    const code = {
      name: "sum",
      type: "code",
      title: { en: "Sum" },
      description: "Adds numbers.",
      input: { type: "object" },
      runtime: "python",
      entry: "main.py",
      files: [
        { path: "main.py", content: "print('{}')" },
        { path: "lib/util.py", content: "" }
      ]
    };
    const accepted = (overrides: Record<string, unknown>) =>
      toolAssetConfigSchema.safeParse({ ...code, ...overrides }).success;
    expect(accepted({})).toBe(true);
    expect(
      accepted({ runtime: "node", entry: "index.mjs", files: [{ path: "index.mjs", content: "" }] })
    ).toBe(true);
    expect(accepted({ timeoutSeconds: 120 })).toBe(true);
    // The handler must be among the files, in the runtime's language.
    expect(accepted({ entry: "missing.py" })).toBe(false);
    expect(accepted({ runtime: "node" })).toBe(false);
    expect(accepted({ files: [] })).toBe(false);
    // A timeout of at most two minutes; no result block, no Connections yet.
    expect(accepted({ timeoutSeconds: 121 })).toBe(false);
    expect(accepted({ timeoutSeconds: 0 })).toBe(false);
    expect(accepted({ result: definition.result })).toBe(false);
    expect(accepted({ connections: ["crm.find_contact"] })).toBe(false);
    // Paths stay inside the folder, once each.
    for (const path of ["../main.py", "/etc/main.py", ".hidden.py", "a//b.py", "lib/../x.py"]) {
      expect(accepted({ files: [...code.files, { path, content: "" }] }), path).toBe(false);
    }
    expect(accepted({ files: [...code.files, { path: "MAIN.py", content: "" }] })).toBe(false);
    expect(accepted({ files: [...code.files, { path: "main.py/x.py", content: "" }] })).toBe(false);
    // Bounded in count and size.
    const many = Array.from({ length: TOOL_FILES_MAX }, (_, at) => ({
      path: `f${String(at)}.py`,
      content: ""
    }));
    expect(accepted({ entry: "f0.py", files: many })).toBe(true);
    expect(accepted({ entry: "f0.py", files: [...many, { path: "g.py", content: "" }] })).toBe(
      false
    );
    const large = "x".repeat(TOOL_FILE_MAX_BYTES + 1);
    expect(accepted({ files: [...code.files, { path: "big.py", content: large }] })).toBe(false);
    const half = "x".repeat(TOOL_FILE_MAX_BYTES);
    expect(
      accepted({
        files: [
          ...code.files,
          { path: "a.py", content: half },
          { path: "b.py", content: half },
          { path: "c.py", content: "x" }
        ]
      })
    ).toBe(false);
    expect(accepted({ files: [...code.files, { path: "nul.py", content: "a\u0000b" }] })).toBe(
      false
    );
  });

  it("names its operation tool.<name>.call, which agents list without a release", () => {
    expect(operationName).toBe("tool.submit_review.call");
    expect(toolOfOperationName(operationName)).toBe("submit_review");
    expect(toolOfOperationName("tool.submit_review.start")).toBeUndefined();
    expect(toolOfOperationName("tool.Bad.call")).toBeUndefined();
    expect(dataToolPrefixOf(operationName)).toBe("tool.");
    expect(
      findMissingAgentToolReferences(
        [{ name: "reviewer", toolNames: [operationName, "unknown.tool"] }],
        []
      ).map((missing) => missing.referenceName)
    ).toEqual(["unknown.tool"]);
  });
});

describe("the operation of a published tool", () => {
  it("reads through a caller's transaction stores where it is handed them", async () => {
    const { resolveMany } = createToolOperationSource({
      clientInstanceId,
      store: storeOf(),
      checker
    });
    if (resolveMany === undefined) throw new Error("The source resolves no names at once");
    expect(await resolveMany([operationName])).toEqual([]);
    const inTransaction = storeOf(record());
    const found = await resolveMany([operationName], {
      configAssets: inTransaction,
      connections: { getConnectionState: async () => undefined },
      dataStores: { getDataStore: async () => undefined }
    });
    expect(found.map((operation) => operation.name)).toEqual([operationName]);
  });

  it("is offered from the published revision only", async () => {
    const draftOnly = record({ publishedRevisionId: undefined, publishedConfig: undefined });
    const source = createToolOperationSource({
      clientInstanceId,
      store: storeOf(draftOnly),
      checker
    });
    expect(await source.resolve(operationName)).toBeUndefined();
    expect((await source.list({})).operations).toEqual([]);
    const deleted = record({ status: "deleted" });
    expect(
      await createToolOperationSource({
        clientInstanceId,
        store: storeOf(deleted),
        checker
      }).resolve(operationName)
    ).toBeUndefined();

    const published = await resolved(record());
    expect(published).toMatchObject({
      name: operationName,
      effect: "changing",
      defaultPolicy: "allow",
      draftTarget: "test",
      action: null
    });
    const described = await createToolAssetToolSource({
      clientInstanceId,
      store: storeOf(record()),
      checker
    }).describe([operationName, "tool.other.call"], {});
    expect(described).toEqual([
      expect.objectContaining({ name: operationName, revisionId: "rev-1", effect: "changing" })
    ]);
  });

  it("refuses input the schema refuses, and every caller that is no agent", async () => {
    const operation = await resolved(record());
    expect((await operation.inputSchema.safeParseAsync({ verdict: "complete" })).success).toBe(
      true
    );
    expect((await operation.inputSchema.safeParseAsync({ verdict: "maybe" })).success).toBe(false);
    expect((await operation.inputSchema.safeParseAsync({ extra: 1 })).success).toBe(false);
    const authorize = operation.authorize;
    if (authorize === undefined) throw new Error("The tool has no authorize");
    const asked = (origin: OperationOrigin) =>
      authorize({}, { ...contextOf(origin), resource: undefined });
    expect(await asked(agentOrigin)).toEqual({ allowed: true });
    expect(await asked({ kind: "cli" })).toMatchObject({ allowed: false });
    expect(await asked({ kind: "user" })).toMatchObject({ allowed: false });
    await expect(operation.execute({}, contextOf({ kind: "user" }))).rejects.toThrow();
  });

  it("writes the agent's input as the conversation's result of its display kind", async () => {
    const operation = await resolved(record());
    const input = { verdict: "incomplete", findings: ["The land register extract is missing."] };
    const answer = await operation.execute(input, contextOf(agentOrigin));
    if (!isToolOperationAnswer(answer)) throw new Error("The tool did not answer as a tool");
    expect(answer.result).toEqual({
      status: "success",
      output: {
        key: "submit_review",
        kind: "review.document_check",
        schemaVersion: 1,
        message: "Handed to the panel."
      },
      structuredResult: {
        key: "submit_review",
        kind: "review.document_check",
        schemaVersion: 1,
        title: "Review",
        data: input
      }
    });
  });

  it("refuses a waiting call once the tool was published again", async () => {
    const operation = await resolved(record({ publishedRevisionId: "rev-3" }));
    await expect(
      operation.execute(
        { verdict: "complete" },
        contextOf({ ...agentOrigin, toolRevisionId: "rev-1" })
      )
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "tool_revision_changed" } });
    await expect(
      operation.execute(
        { verdict: "complete" },
        contextOf({ ...agentOrigin, toolRevisionId: "rev-3" })
      )
    ).resolves.toBeTruthy();
  });
});

describe("a code tool's answer", () => {
  const answer = (value: JsonValue, personal = false) =>
    toolCodeCallAnswer({
      tool: "sum",
      timeoutSeconds: 30,
      result: { status: "ended", outcome: { kind: "answered", value } },
      personal
    });

  it("hands the model its output, bounded, and refuses an answer of another shape", () => {
    expect(answer({ output: "fine" })).toEqual({ status: "success", output: "fine" });
    expect(answer({ output: null })).toEqual({ status: "success", output: null });
    const big = answer({ output: "x".repeat(TOOL_CODE_OUTPUT_MAX_BYTES + 1) });
    expect(big).toMatchObject({
      status: "failed",
      error: { details: { reason: "tool_answer_invalid" } }
    });
    expect(JSON.stringify(big).length).toBeLessThan(2_000);
    const invalids: JsonValue[] = [
      "text",
      [1],
      {},
      { output: 1, extra: true },
      { output: 1, display: { type: "pdf" } },
      { output: 1, display: { type: "data", kind: "Bad Kind", title: "T", data: {} } },
      { output: 1, display: { type: "data", kind: "a.b", data: {} } },
      { output: 1, display: { type: "html", html: "x".repeat(TOOL_CODE_HTML_MAX_CHARS + 1) } }
    ];
    for (const invalid of invalids) {
      expect(answer(invalid), JSON.stringify(invalid).slice(0, 80)).toMatchObject({
        status: "failed",
        error: { code: "handler_failed", details: { reason: "tool_answer_invalid" } }
      });
    }
  });

  it("names a timeout as timed_out, and any other failure as the handler's", () => {
    const ended = (code: string) =>
      toolCodeCallAnswer({
        tool: "sum",
        timeoutSeconds: 5,
        result: { status: "ended", outcome: { kind: "failed", error: { code, message: "m" } } },
        personal: false
      });
    expect(ended("code_timeout")).toMatchObject({
      status: "timed_out",
      error: { code: "timed_out" }
    });
    expect(ended("code_out_of_memory")).toMatchObject({
      status: "failed",
      error: { code: "handler_failed", details: { reason: "code_out_of_memory" } }
    });
    expect(
      toolCodeCallAnswer({
        tool: "sum",
        timeoutSeconds: 5,
        result: { status: "cancelled" },
        personal: false
      })
    ).toMatchObject({ status: "cancelled" });
  });
});
