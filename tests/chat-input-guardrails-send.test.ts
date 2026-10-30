import { afterEach, describe, expect, it } from "vitest";
import { asClientInstanceId, CHAT_INPUT_EVENT } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestConfig, type TestInstance } from "./support/test-instance";
import {
  createMultipartFilePayload,
  createTestAttachmentCapability,
  waitForReadyDraftAttachment
} from "./support/chat-server-attachment-harness";
import { withTestSql } from "./support/test-sql";

// A person's chat message under the guardrails on chat input (GR-4): a block refuses it and
// stores nothing, a warning refuses it until it is sent anyway, attachments are checked as far
// as their text can be read when it is sent, and no text of a refused message is kept anywhere.
// Spec: events-workflows-and-guardrails.md, Guardrails on chat, acceptance checks 59 to 61.

const SECRET = `ghp_${"Zq9xWv8uTs".repeat(4)}`;
const CARD = "4111 1111 1111 1111";
const PASSWORD = "Passwort: Herbstlaub-7713";

let app: TestInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function instance(attachments: Parameters<typeof createTestAttachmentCapability>[0] = {}) {
  app = await createTestInstance({
    config: createTestConfig(),
    env: {},
    capabilities: [createTestAttachmentCapability(attachments)],
    tools: []
  });
  const created = await app.call("conversations.create", { payload: { title: "Chat input" } });
  const conversation = created.json<{ id: string }>();
  return { app, conversationId: conversation.id };
}

function send(
  server: TestInstance,
  conversationId: string,
  text: string,
  options: { key?: string; accept?: true } = {}
) {
  return server.call("conversations.runs.start", {
    params: { conversationId },
    payload: {
      idempotencyKey: options.key ?? `chat-input-${Math.random().toString(36).slice(2)}`,
      message: { text },
      ...(options.accept ? { acceptGuardrailWarnings: true } : {})
    }
  });
}

async function userMessages(server: TestInstance, conversationId: string) {
  const listed = await server.call("conversations.messages.list", { params: { conversationId } });
  return listed
    .json<{ items: Array<{ role: string; text: string }> }>()
    .items.filter((message) => message.role === "user");
}

async function upload(
  server: TestInstance,
  conversationId: string,
  file: { filename: string; contentType: string; content: string | Buffer }
) {
  const payload = createMultipartFilePayload({ fieldName: "file", ...file });
  const uploaded = await server.call("conversations.draft_attachments.upload", {
    params: { conversationId },
    headers: payload.headers,
    payload: payload.payload
  });
  expect(uploaded.statusCode).toBe(200);
  await waitForReadyDraftAttachment(server, conversationId);
}

/** Every row of every table, as text: where a refused message's text would be kept. */
async function everyStoredRow(): Promise<string> {
  return withTestSql(async (sql) => {
    const tables = await sql<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
    const rows: string[] = [];
    for (const { name } of tables) {
      const found = await sql.unsafe(`SELECT t::text AS row FROM "${name}" t`);
      rows.push(...found.map((row) => String(row.row)));
    }
    return rows.join("\n");
  });
}

function errorOf(response: { json<T>(): T }) {
  return response.json<{
    error: { code: string; details?: Record<string, unknown> };
  }>().error;
}

describe("a chat message under the guardrails on chat input", () => {
  // Fails without the change: the message was stored and went to the model.
  it("is refused by a block, stored nowhere, and named by its guardrail", async () => {
    const { app: server, conversationId } = await instance();
    const blocked = await send(server, conversationId, `Mein Token: ${SECRET}`);
    expect(blocked.statusCode).toBeGreaterThanOrEqual(400);
    const error = errorOf(blocked);
    expect(error.code).toBe("GUARDRAIL_BLOCKED");
    expect(error.details).toMatchObject({
      reason: "chat_input_blocked",
      guardrailId: "chat-secrets",
      guardrails: [
        expect.objectContaining({ name: "chat-secrets", outcome: "block", origin: "release" })
      ]
    });
    expect(JSON.stringify(blocked.json())).not.toContain(SECRET);
    expect(await userMessages(server, conversationId)).toEqual([]);
    // Neither the message, nor the hit, the audit, the outbox or a job keeps its text.
    expect(await everyStoredRow()).not.toContain(SECRET.slice(4, 24));
  });

  it("is refused by a block before a new conversation is created for it", async () => {
    const { app: server } = await instance();
    const listed = async () =>
      (await server.call("conversations.list")).json<{ items: unknown[] }>().items.length;
    const before = await listed();
    const blocked = await server.call("conversations.runs.create", {
      payload: { idempotencyKey: "chat-input-create", message: { text: `Karte ${CARD}` } }
    });
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "chat-card-numbers" }
    });
    expect(await listed()).toBe(before);
  });

  // Fails without the change: a warning let the message through unasked.
  it("waits on a warning until the person sends it anyway, and counts the warning once", async () => {
    const { app: server, conversationId } = await instance();
    const warned = await send(server, conversationId, PASSWORD, { key: "warned" });
    expect(warned.statusCode).toBe(409);
    expect(errorOf(warned)).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "chat_input_warning",
        guardrails: [expect.objectContaining({ name: "chat-passwords", outcome: "warn" })]
      }
    });
    expect(await userMessages(server, conversationId)).toEqual([]);

    const sent = await send(server, conversationId, PASSWORD, { key: "warned", accept: true });
    expect(sent.statusCode).toBe(200);
    expect(await userMessages(server, conversationId)).toEqual([
      expect.objectContaining({ text: PASSWORD })
    ]);
    const clientInstanceId = asClientInstanceId(getTestConfig(server).clientInstance.id);
    expect(
      await server.stores.guardrails.countHits({
        clientInstanceId,
        guardrailName: "chat-passwords"
      })
    ).toMatchObject({ last30Days: 1 });
    const hits = await withTestSql(
      (sql) =>
        sql`SELECT event, field, match_count, message FROM guardrail_hits WHERE guardrail_name = 'chat-passwords'`
    );
    expect(hits).toEqual([
      expect.objectContaining({ event: CHAT_INPUT_EVENT, field: "text", match_count: 1 })
    ]);
    expect(JSON.stringify(hits)).not.toContain("Herbstlaub");
  });

  it("still blocks a message sent anyway", async () => {
    const { app: server, conversationId } = await instance();
    const blocked = await send(server, conversationId, `${PASSWORD} und ${SECRET}`, {
      accept: true
    });
    expect(errorOf(blocked)).toMatchObject({ code: "GUARDRAIL_BLOCKED" });
    expect(await userMessages(server, conversationId)).toEqual([]);
  });

  it("goes as usual where nothing matches, an IBAN and a tax id included", async () => {
    const { app: server, conversationId } = await instance();
    const sent = await send(
      server,
      conversationId,
      "Bitte überweise auf DE89 3704 0044 0532 0130 00, Steuer-ID 65 929 970 489."
    );
    expect(sent.statusCode).toBe(200);
    expect(sent.json<{ chatInput?: unknown }>().chatInput).toBeUndefined();
  });

  // Fails without the change: an attachment's text was never checked.
  it("checks the text of a text attachment", async () => {
    const { app: server, conversationId } = await instance();
    await upload(server, conversationId, {
      filename: "zahlung.txt",
      contentType: "text/plain",
      content: `Karte: ${CARD}`
    });
    const blocked = await send(server, conversationId, "Siehe Anhang.");
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "chat-card-numbers" }
    });
    const [hit] = await withTestSql(
      (sql) => sql`SELECT field FROM guardrail_hits WHERE guardrail_name = 'chat-card-numbers'`
    );
    expect(hit).toEqual({ field: "attachments" });
  });

  // Fails without the change: a file whose text could not be read passed unsaid.
  it("says which attachments it could not check, and sends them", async () => {
    const { app: server, conversationId } = await instance();
    await upload(server, conversationId, {
      filename: "bild.png",
      contentType: "image/png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    });
    const sent = await send(server, conversationId, "Was zeigt das Bild?");
    expect(sent.statusCode).toBe(200);
    expect(sent.json<{ chatInput?: unknown }>().chatInput).toEqual({
      attachmentsNotChecked: [expect.objectContaining({ filename: "bild.png", cause: "image" })]
    });
  });

  // Fails without the change: a PDF's prepared text was never checked, though the message
  // waits until it is ready.
  it("checks the text a document capability prepared of a PDF", async () => {
    const { app: server, conversationId } = await instance({
      preparedTexts: { "vertrag.pdf": { text: `Zahlung per Karte ${CARD}` } }
    });
    await upload(server, conversationId, {
      filename: "vertrag.pdf",
      contentType: "application/pdf",
      content: Buffer.from("%PDF-1.4\n%")
    });
    const blocked = await send(server, conversationId, "Bitte prüfe den Vertrag.");
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "chat-card-numbers" }
    });
    expect(errorOf(blocked).details).not.toHaveProperty("attachmentsNotChecked");
    const [hit] = await withTestSql(
      (sql) => sql`SELECT field FROM guardrail_hits WHERE guardrail_name = 'chat-card-numbers'`
    );
    expect(hit).toEqual({ field: "attachments" });
    expect(await everyStoredRow()).not.toContain("4111 1111 1111 1111");
  });

  // Fails without the change: a Markdown file, which the document capability tags `md`, came
  // back as not checked.
  it("checks a Markdown file tagged md as text", async () => {
    const { app: server, conversationId } = await instance({ formats: { "notiz.md": "md" } });
    await upload(server, conversationId, {
      filename: "notiz.md",
      contentType: "text/markdown",
      content: `# Zugang\n\nToken: ${SECRET}`
    });
    const blocked = await send(server, conversationId, "Siehe Notiz.");
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "chat-secrets" }
    });
  });

  it("says what of a document was not checked: no prepared text, or text cut short", async () => {
    const { app: server, conversationId } = await instance({
      preparedTexts: { "lang.pdf": { text: "Ein langer Bericht.", truncated: true } }
    });
    await upload(server, conversationId, {
      filename: "vertrag.pdf",
      contentType: "application/pdf",
      content: Buffer.from("%PDF-1.4\n%")
    });
    await upload(server, conversationId, {
      filename: "lang.pdf",
      contentType: "application/pdf",
      content: Buffer.from("%PDF-1.4\n%")
    });
    const warned = await send(server, conversationId, PASSWORD);
    expect(errorOf(warned)).toMatchObject({
      code: "CONFLICT",
      details: {
        attachmentsNotChecked: [
          expect.objectContaining({ filename: "vertrag.pdf", cause: "not_extracted" }),
          expect.objectContaining({ filename: "lang.pdf", cause: "too_large" })
        ]
      }
    });
  });
});
