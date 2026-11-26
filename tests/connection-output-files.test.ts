import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  CONNECTION_OUTPUT_FILE_MAX_BYTES,
  connectionCallReasonOf,
  type ConnectionWorkspaceFiles,
  type ConnectorOperationDescriptor
} from "@work-shape/catalyst-core";
import { createConnectionWorkspaceFiles } from "@work-shape/catalyst-client-assembly";
import { required } from "./support/assertions";
import { setupAccessInstance } from "./support/access-instance";
import {
  agentOrigin,
  fixtureOn,
  operationOf,
  type ConnectionOperationsFixture
} from "./support/connection-operations";
import { createWorkspaceHarness, encode } from "./support/workspace-tools-harness";

// An operation that `producesFiles` saves a file into the calling conversation's execution
// workspace. The type is handed a saver; the bytes never enter the result, the run or the audit.

const fetching: ConnectorOperationDescriptor = {
  name: "fetch_file",
  description: "Saves a file of the outside system.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  proposedEffect: "reading",
  producesFiles: true
};
const OPERATION = "connection.crm.fetch_file";
const CONTENT = "the file's bytes";

async function setup() {
  const t = await fixtureOn(setupAccessInstance, { catalog: [fetching] });
  const assetId = await t.seed("crm", { operations: [operationOf("fetch_file")] });
  await t.grant(t.kai.id, "connection.use", { assetId });
  t.state.agentTools.set("assistant", [OPERATION]);
  t.setBehaviour(async (_operation, _input, context) => {
    const saved = await context.outputFiles?.save({
      name: "report.pdf",
      mediaType: "application/pdf",
      bytes: encode(CONTENT)
    });
    return { path: saved?.path ?? null };
  });
  return t;
}

function withPort(t: ConnectionOperationsFixture, port: ConnectionWorkspaceFiles | undefined) {
  if (port) t.sourceDeps.workspaceFiles = port;
  else delete t.sourceDeps.workspaceFiles;
}

const call = (t: ConnectionOperationsFixture, origin = agentOrigin(OPERATION)) =>
  t.invoke(t.kai, OPERATION, {}, { origin });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a file a Connection operation saves", () => {
  it("is saved through the port, and the result and the run hold only its path", async () => {
    const t = await setup();
    const save = vi.fn<ConnectionWorkspaceFiles["save"]>(() =>
      Promise.resolve({ path: "inputs/report.pdf", byteSize: CONTENT.length })
    );
    withPort(t, { save });

    const outcome = await call(t);

    expect(outcome.result).toMatchObject({
      status: "done",
      output: { path: "inputs/report.pdf" }
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.kai.id }),
      { conversationId: "conv_test", operation: OPERATION },
      { name: "report.pdf", mediaType: "application/pdf", bytes: encode(CONTENT) }
    );
    expect(JSON.stringify(await t.runs())).not.toContain(CONTENT);
  });

  it("is refused before the type runs outside an agent's conversation or without a port", async () => {
    const t = await setup();
    const save = vi.fn<ConnectionWorkspaceFiles["save"]>();
    withPort(t, { save });
    expect((await t.failure(call(t, { kind: "cli" }))).reason).toBe("output_file_unavailable");
    withPort(t, undefined);
    expect((await t.failure(call(t))).reason).toBe("output_file_unavailable");
    expect(t.executed).toEqual([]);
    expect(t.sequence).not.toContain("check egress");
    expect(save).not.toHaveBeenCalled();
  });

  it("is refused over 50 MiB before the port sees it", async () => {
    const t = await setup();
    const save = vi.fn<ConnectionWorkspaceFiles["save"]>();
    withPort(t, { save });
    t.setBehaviour(async (_operation, _input, context) => {
      await context.outputFiles?.save({
        name: "big.bin",
        bytes: new Uint8Array(CONNECTION_OUTPUT_FILE_MAX_BYTES + 1)
      });
      return {};
    });
    expect((await t.failure(call(t))).reason).toBe("output_file_too_large");
    expect(save).not.toHaveBeenCalled();
  });

  it("takes a free path from its name in the workspace, replaces on a retry, and keeps within its room", async () => {
    const harness = await createWorkspaceHarness({ limits: { maxWorkspaceBytes: 64 } });
    const port = createConnectionWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspace: harness.service
    });
    const actor = harness.context.user;
    const ref = { conversationId: harness.conversation.id, operation: OPERATION };
    const file = { name: "Q3 report.pdf", mediaType: "application/pdf", bytes: encode("one") };

    expect(await port.save(actor, ref, file)).toEqual({
      path: "inputs/Q3-report.pdf",
      byteSize: 3
    });
    // The same name again never replaces a file; the retry of an attempt does.
    expect((await port.save(actor, ref, file)).path).toBe("inputs/Q3-report-1.pdf");
    expect(
      (
        await port.save(actor, ref, {
          ...file,
          bytes: encode("two"),
          replaces: "inputs/Q3-report-1.pdf"
        })
      ).path
    ).toBe("inputs/Q3-report-1.pdf");
    const workspace = await harness.store.executionWorkspaces.getExecutionWorkspaceForConversation({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id
    });
    const files = await harness.store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: required(workspace).id
    });
    const saved = files.map(({ path, mimeType, metadata }) => ({ path, mimeType, metadata }));
    expect(saved.sort((a, b) => a.path.localeCompare(b.path))).toMatchObject([
      {
        path: "inputs/Q3-report-1.pdf",
        mimeType: "application/pdf",
        metadata: { source: OPERATION }
      },
      { path: "inputs/Q3-report.pdf", mimeType: "application/pdf", metadata: { source: OPERATION } }
    ]);

    const refused: unknown = await port
      .save(actor, ref, { name: "big.bin", bytes: new Uint8Array(64) })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect(connectionCallReasonOf(refused)).toBe("output_file_too_large");
  });
});
