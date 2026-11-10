import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  connectionOriginOf,
  createConnectionCredentialResolver,
  createEgressChecker,
  createSecretStore,
  loadSecretKeyring,
  openConnectorContext
} from "@work-shape/catalyst-connections";
import {
  SHARED_CREDENTIAL_SUBJECT,
  asClientInstanceId,
  connectionCallReasonOf,
  connectionCallsArePersonal,
  createConnectionSecretHandle,
  createConnectorTypeRegistry,
  findConnectorTypeIssues,
  type ConnectorContext,
  type ConnectorTypeDefinition,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import {
  IMAP_CONNECTOR_TYPE,
  MESSAGE_TEXT_MAX_CHARS,
  createImapConnectorType
} from "@work-shape/catalyst-imap-connector";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { required } from "./support/assertions";
import { connection } from "./support/connections";
import {
  startImapTestServer,
  type FakeFolder,
  type FakeMessage,
  type ImapTestServer,
  type ImapTestServerOptions
} from "./support/imap-test-server";
import { loopbackEgress, refusal, told } from "./support/mcp-test-server";
import { makeTestCertificate, type TestCertificate } from "./support/test-certificate";
import {
  captureProcessOutput,
  findLeak,
  generateSecretStoreKey,
  generateTestSecret
} from "./support/test-connector";
import { createTestInstance, type TestPostgresStore } from "./support/test-instance";

// The Connector type `imap` against an IMAP server in this process over TLS, through the real
// egress checker (with a resolver of the test), the real Secret Store over real rows and
// `openConnectorContext`. The account and every message are made up here.

const clientInstanceId = asClientInstanceId("imap-connector-test");
const HOST = "mail.example.test";
const USERNAME = "desk@example.test";

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 9, 30));
const person = (mailbox: string, name?: string) => ({
  mailbox,
  host: "example.test",
  ...(name === undefined ? {} : { name })
});
const plain = (body: string): FakeMessage["body"] => ({
  type: "text/plain",
  charset: "utf-8",
  body
});

function message(uid: number, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    uid,
    date: at(uid),
    subject: `Request ${uid}`,
    from: [person(`sender${uid}`, `Sender ${uid}`)],
    to: [person("desk")],
    messageId: `<m${uid}@example.test>`,
    body: plain(`Body of message ${uid}.`),
    ...overrides
  };
}

const inbox = (messages: FakeMessage[], uidValidity = 7): FakeFolder => ({
  uidValidity,
  messages
});

describe("the Connector type imap", () => {
  let stores: TestPostgresStore;
  let certificate: TestCertificate;
  let caBefore: string[];
  const servers: ImapTestServer[] = [];
  const type: ConnectorTypeDefinition = createImapConnectorType();
  const storeKey = generateSecretStoreKey();
  let connected = 0;

  beforeAll(() => {
    certificate = makeTestCertificate(HOST);
    caBefore = getCACertificates("default");
    setDefaultCACertificates([...caBefore, certificate.authority]);
  });

  afterAll(() => {
    setDefaultCACertificates(caBefore);
  });

  beforeEach(async () => {
    stores = (await createTestInstance({ postgres: {} })).stores;
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serve(
    folders: Record<string, FakeFolder>,
    options: Partial<ImapTestServerOptions> & { password?: string } = {}
  ): Promise<ImapTestServer & { password: string }> {
    const password = options.password ?? generateTestSecret();
    const server = await startImapTestServer({
      tls: certificate,
      account: { username: USERNAME, password },
      folders,
      ...options
    });
    servers.push(server);
    return Object.assign(server, { password });
  }

  interface Setup {
    port: number;
    password: string;
    folders?: string[];
    username?: string;
    allow?: { host: string; port: number; protocol: "imaps" | "https" }[];
  }

  async function connect(setup: Setup) {
    connected += 1;
    const name = `mailbox-${connected}`;
    const handle = createConnectionSecretHandle();
    const config = connection(name, {
      connectorType: IMAP_CONNECTOR_TYPE,
      settings: {
        host: HOST,
        port: setup.port,
        username: setup.username ?? USERNAME,
        folders: setup.folders ?? ["INBOX"]
      },
      authScheme: "password",
      secretHandle: handle,
      operations: [
        { name: "search_messages", effect: "reading", exposure: ["agent"], enabled: true },
        { name: "get_message", effect: "reading", exposure: ["agent"], enabled: true }
      ]
    });
    await applyAtCurrentRevisions(stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "upsert", kind: "connection", name, config }]
    });
    const stored = required(
      await stores.configAssets.getConfigAsset({ clientInstanceId, kind: "connection", name })
    );
    const parsed = connectionConfigSchema.parse(stored.config);
    const keyring = await loadSecretKeyring({
      keys: [{ id: "k1", ref: "STORE_KEY" }],
      secrets: { resolve: () => Promise.resolve(storeKey) }
    });
    await createSecretStore({ clientInstanceId, keyring, store: stores.connections }).put({
      binding: { connectionAssetId: stored.id, subject: SHARED_CREDENTIAL_SUBJECT },
      value: setup.password,
      source: "runtime",
      handle,
      origin: connectionOriginOf(type, parsed)
    });
    const egress = loopbackEgress(
      setup.allow ?? [{ host: HOST, port: setup.port, protocol: "imaps" }]
    );
    const open = (signal: AbortSignal = new AbortController().signal): Promise<ConnectorContext> =>
      openConnectorContext({
        type,
        connection: { id: stored.id, revision: stored.revision, config: parsed },
        egress: egress.checker,
        credentials: createConnectionCredentialResolver({
          clientInstanceId,
          keyring,
          store: stores.connections
        }),
        signal
      });
    return {
      egress,
      test: async () => type.test(await open()),
      execute: async (operation: string, input: JsonObject = {}): Promise<JsonValue> =>
        type.execute(operation, input, await open())
    };
  }

  const reasonOf = async (work: Promise<unknown>) => connectionCallReasonOf(await refusal(work));
  const sent = (server: ImapTestServer) => server.commands.map((command) => command.name);
  const pageSchema = z.object({
    items: z.array(z.looseObject({ id: z.string(), subject: z.string().optional() })),
    nextCursor: z.string().optional()
  });
  const messageSchema = z.looseObject({ text: z.string() });
  const pageOf = (value: JsonValue) => pageSchema.parse(value);
  const messageOf = (value: JsonValue) => messageSchema.parse(value);

  describe("reading", () => {
    it("searches newest first and leaves every flag as it was, with EXAMINE and no change", async () => {
      const server = await serve({
        INBOX: inbox([
          message(1, { flags: ["\\Seen"] }),
          message(2),
          message(3, {
            body: {
              type: "multipart/mixed",
              children: [
                plain("See the file."),
                {
                  type: "application/pdf",
                  encoding: "base64",
                  disposition: "attachment",
                  filename: "offer.pdf",
                  body: "JVBERi0="
                }
              ]
            }
          })
        ])
      });
      const w = await connect({ port: server.port, password: server.password });
      const result = pageOf(await w.execute("search_messages", {}));
      const { items } = result;
      expect(items.map((item) => item.subject)).toEqual(["Request 3", "Request 2", "Request 1"]);
      expect(items[0]).toMatchObject({
        from: "Sender 3 <sender3@example.test>",
        attachmentCount: 1,
        seen: false,
        date: at(3).toISOString()
      });
      expect(items[2]?.seen).toBe(true);
      expect(result.nextCursor).toBeUndefined();
      expect(sent(server)).toContain("EXAMINE");
      expect(sent(server)).not.toContain("SELECT");
      expect(sent(server).some((name) => name.includes("STORE"))).toBe(false);
      expect(sent(server).at(-1)).toBe("LOGOUT");
      expect(server.flagsOf("INBOX", 1)).toEqual(["\\Seen"]);
      expect(server.flagsOf("INBOX", 2)).toEqual([]);
      expect(server.serverNames).toEqual([HOST]);
    });

    it("reads a message with BODY.PEEK: plain text before HTML, attachments named and never fetched", async () => {
      const server = await serve({
        INBOX: inbox([
          message(5, {
            cc: [person("colleague", "A Colleague")],
            inReplyTo: "<m4@example.test>",
            body: {
              type: "multipart/mixed",
              children: [
                {
                  type: "multipart/alternative",
                  children: [
                    {
                      type: "text/plain",
                      charset: "iso-8859-1",
                      encoding: "quoted-printable",
                      body: "Gr=FC=DFe aus dem B=FCro"
                    },
                    { type: "text/html", charset: "utf-8", body: "<p>HTML version</p>" }
                  ]
                },
                {
                  type: "application/pdf",
                  encoding: "base64",
                  disposition: "attachment",
                  filename: "plan.pdf",
                  body: "JVBERi0xLjQK"
                }
              ]
            }
          })
        ])
      });
      const w = await connect({ port: server.port, password: server.password });
      const [found] = pageOf(await w.execute("search_messages", {})).items;
      const read = messageOf(await w.execute("get_message", { id: required(found).id }));
      expect(read).toMatchObject({
        subject: "Request 5",
        from: "Sender 5 <sender5@example.test>",
        to: ["desk@example.test"],
        cc: ["A Colleague <colleague@example.test>"],
        inReplyTo: "<m4@example.test>",
        messageId: "<m5@example.test>",
        text: "Grüße aus dem Büro",
        truncated: false,
        attachments: [{ part: "2", name: "plan.pdf", type: "application/pdf", size: 12 }]
      });
      const fetches = server.commands.filter((command) => command.name === "UID FETCH");
      const bodies = fetches.map((command) => command.args).join(" ");
      expect(bodies).toMatch(/BODY\.PEEK\[1\.1\]/u);
      expect(bodies).not.toMatch(/BODY\[/u);
      expect(bodies).not.toMatch(/BINARY/u);
      expect(bodies).not.toMatch(/\[2\]|\[1\.2\]/u);
      expect(server.flagsOf("INBOX", 5)).toEqual([]);
    });

    it("reduces an HTML-only message to its text, without script or style", async () => {
      const server = await serve({
        INBOX: inbox([
          message(1, {
            body: {
              type: "text/html",
              charset: "utf-8",
              encoding: "base64",
              body: Buffer.from(
                '<html><head><style>p{}</style><script>steal()</script></head><body><p>First</p><p>Second &amp; last</p><img src="https://tracker.example.test/p.gif"></body></html>'
              ).toString("base64")
            }
          })
        ])
      });
      const w = await connect({ port: server.port, password: server.password });
      const [found] = pageOf(await w.execute("search_messages", {})).items;
      const read = messageOf(await w.execute("get_message", { id: required(found).id }));
      expect(read.text).toBe("First\n\nSecond & last");
      expect(read.attachments).toEqual([]);
    });

    it("caps the text and the address lists, and says so", async () => {
      const recipients = Array.from({ length: 25 }, (_, index) => person(`r${index}`));
      const server = await serve({
        INBOX: inbox([
          message(1, { to: recipients, body: plain("x".repeat(MESSAGE_TEXT_MAX_CHARS + 500)) })
        ])
      });
      const w = await connect({ port: server.port, password: server.password });
      const [found] = pageOf(await w.execute("search_messages", {})).items;
      const read = messageOf(await w.execute("get_message", { id: required(found).id }));
      expect(read.text.length).toBe(MESSAGE_TEXT_MAX_CHARS);
      expect(read.truncated).toBe(true);
      expect(read.to).toHaveLength(20);
      expect(read.toOmitted).toBe(5);
    });

    it("pages with a cursor and refuses one whose folder was renumbered", async () => {
      const server = await serve({
        INBOX: inbox(Array.from({ length: 5 }, (_, index) => message(index + 1)))
      });
      const w = await connect({ port: server.port, password: server.password });
      const first = pageOf(await w.execute("search_messages", { limit: 2 }));
      expect(first.items.map((item) => item.subject)).toEqual(["Request 5", "Request 4"]);
      const second = pageOf(
        await w.execute("search_messages", { limit: 2, cursor: required(first.nextCursor) })
      );
      expect(second.items.map((item) => item.subject)).toEqual(["Request 3", "Request 2"]);
      const third = pageOf(
        await w.execute("search_messages", { limit: 2, cursor: required(second.nextCursor) })
      );
      expect(third.items.map((item) => item.subject)).toEqual(["Request 1"]);
      expect(third.nextCursor).toBeUndefined();

      const [kept] = first.items;
      required(server.folders.INBOX).uidValidity = 8;
      expect(
        await reasonOf(w.execute("search_messages", { cursor: required(second.nextCursor) }))
      ).toBe("cursor_expired");
      expect(await reasonOf(w.execute("get_message", { id: required(kept).id }))).toBe(
        "message_not_found"
      );
    });

    it("filters by sender, subject and day on the server", async () => {
      const server = await serve({
        INBOX: inbox([
          message(1, { subject: "Invoice March" }),
          message(2, { subject: "Invoice April", from: [person("billing", "Billing")] }),
          message(12, { subject: "Invoice May", from: [person("billing", "Billing")] })
        ])
      });
      const w = await connect({ port: server.port, password: server.password });
      const found = pageOf(
        await w.execute("search_messages", {
          from: "billing",
          subject: "invoice",
          before: "2026-10-10"
        })
      );
      expect(found.items.map((item) => item.subject)).toEqual(["Invoice April"]);
      const since = pageOf(await w.execute("search_messages", { since: "2026-10-02" }));
      expect(since.items.map((item) => item.subject)).toEqual(["Invoice May", "Invoice April"]);
    });
  });

  describe("the folder boundary", () => {
    it("refuses a folder and an id outside the Connection's folders before it connects", async () => {
      const server = await serve({ INBOX: inbox([message(1)]), Private: inbox([message(1)]) });
      const w = await connect({ port: server.port, password: server.password });
      expect(await reasonOf(w.execute("search_messages", { folder: "Private" }))).toBe(
        "folder_not_found"
      );
      const outside = Buffer.from(JSON.stringify([1, "Private", "7", 1])).toString("base64url");
      expect(await reasonOf(w.execute("get_message", { id: outside }))).toBe("message_not_found");
      expect(await reasonOf(w.execute("get_message", { id: "not-an-id" }))).toBe(
        "message_not_found"
      );
      expect(server.connections()).toBe(0);
    });

    it("answers folder_not_found for a listed folder the server does not have", async () => {
      const server = await serve({ INBOX: inbox([message(1)]) });
      const w = await connect({
        port: server.port,
        password: server.password,
        folders: ["INBOX", "Gone"]
      });
      expect(await reasonOf(w.execute("search_messages", { folder: "Gone" }))).toBe(
        "folder_not_found"
      );
      expect(await reasonOf(w.test())).toBe("folder_not_found");
    });

    it("refuses input it does not read without repeating it", async () => {
      const server = await serve({ INBOX: inbox([]) });
      const w = await connect({ port: server.port, password: server.password });
      const error = await refusal(
        w.execute("search_messages", { limit: 500, subject: "secret words" })
      );
      expect(connectionCallReasonOf(error)).toBe("input_invalid");
      expect(told(error)).not.toContain("secret words");
      expect(await reasonOf(w.execute("delete_message", {}))).toBe("operation_unknown");
      expect(server.connections()).toBe(0);
    });
  });

  describe("test", () => {
    it("is ready after a login and an EXAMINE of every folder", async () => {
      const server = await serve({ INBOX: inbox([]), Orders: inbox([]) });
      const w = await connect({
        port: server.port,
        password: server.password,
        folders: ["INBOX", "Orders"]
      });
      expect(await w.test()).toEqual({ status: "ready" });
      expect(sent(server).filter((name) => name === "EXAMINE")).toHaveLength(2);
    });

    it("refuses a wrong password as upstream_unauthorized and repeats nothing of it", async () => {
      const server = await serve({ INBOX: inbox([]) });
      const wrong = generateTestSecret();
      const w = await connect({ port: server.port, password: wrong });
      const output = captureProcessOutput();
      let error;
      try {
        error = await refusal(w.test());
      } finally {
        const printed = output.stop();
        expect(findLeak(printed, wrong)).toBeUndefined();
      }
      expect(connectionCallReasonOf(error)).toBe("upstream_unauthorized");
      expect(findLeak(told(error), wrong)).toBeUndefined();
    });
  });

  describe("transport", () => {
    it("connects to nothing the egress list does not name for imaps", async () => {
      const server = await serve({ INBOX: inbox([]) });
      const w = await connect({
        port: server.port,
        password: server.password,
        allow: [{ host: HOST, port: server.port, protocol: "https" }]
      });
      expect(await reasonOf(w.test())).toBe("egress_denied");
      expect(server.connections()).toBe(0);
    });

    it("is not opened by allowPublicHttps", async () => {
      const checker = createEgressChecker({
        allow: [],
        allowPublicHttps: true,
        resolve: () => Promise.resolve([{ address: "93.184.215.14", family: 4 }])
      });
      expect(await reasonOf(checker.check({ protocol: "imaps", host: HOST, port: 993 }))).toBe(
        "egress_denied"
      );
    });

    it("refuses plain IMAP on port 143 in the settings", () => {
      const settings = { host: HOST, port: 143, username: USERNAME, folders: ["INBOX"] };
      expect(type.settingsSchema.safeParse(settings).success).toBe(false);
      expect(type.settingsSchema.safeParse({ ...settings, port: 993 }).success).toBe(true);
      expect(type.settingsSchema.safeParse({ ...settings, port: 993, password: "x" }).success).toBe(
        false
      );
    });

    it("sends no login to a server that speaks plain IMAP or offers STARTTLS", async () => {
      const server = await serve({ INBOX: inbox([]) }, { tls: false, capabilities: ["STARTTLS"] });
      const w = await connect({ port: server.port, password: server.password });
      expect(await reasonOf(w.test())).toBe("connection_unavailable");
      expect(server.connections()).toBe(1);
      expect(server.commands).toEqual([]);
    });

    it("sends no login to a server whose certificate names another host", async () => {
      const other = makeTestCertificate("other.example.test");
      const before = getCACertificates("default");
      setDefaultCACertificates([...before, other.authority]);
      try {
        const server = await serve({ INBOX: inbox([]) }, { tls: other });
        const w = await connect({ port: server.port, password: server.password });
        expect(await reasonOf(w.test())).toBe("connection_unavailable");
        expect(server.commands).toEqual([]);
      } finally {
        setDefaultCACertificates(before);
      }
    });
  });

  describe("the type", () => {
    it("binds the secret to the server and a digest of the user name, never the name", () => {
      const of = (settings: JsonObject) => required(connectionOriginOf(type, { settings }));
      const base = { host: HOST, port: 993, username: USERNAME, folders: ["INBOX"] };
      const origin = of(base);
      expect(origin).not.toContain(USERNAME);
      expect(origin).not.toContain("desk");
      expect(origin.startsWith(`imaps://${HOST}:993`)).toBe(true);
      expect(of({ ...base, folders: ["INBOX", "Orders"] })).toBe(origin);
      expect(of({ ...base, username: "other@example.test" })).not.toBe(origin);
      expect(of({ ...base, host: "mail2.example.test" })).not.toBe(origin);
      expect(of({ ...base, port: 1993 })).not.toBe(origin);
    });

    it("makes every call personal and accepts the exposure agent only", () => {
      expect(type.privateResults).toBe(true);
      expect(connectionCallsArePersonal({ credentialMode: "shared" }, type)).toBe(true);
      const registry = createConnectorTypeRegistry([type]);
      const config = connectionConfigSchema.parse(
        connection("mailbox", {
          connectorType: IMAP_CONNECTOR_TYPE,
          settings: { host: HOST, username: USERNAME },
          authScheme: "password",
          operations: [
            {
              name: "search_messages",
              effect: "reading",
              exposure: ["agent", "workflow"],
              enabled: true
            },
            { name: "get_message", effect: "reading", exposure: ["bridge"], enabled: true }
          ]
        })
      );
      const issues = findConnectorTypeIssues(registry, config);
      expect(issues.map((issue) => issue.path)).toEqual([
        ["operations", 0, "exposure"],
        ["operations", 1, "exposure"]
      ]);
      expect(type.catalog?.every((operation) => operation.proposedEffect === "reading")).toBe(true);
    });
  });
});
