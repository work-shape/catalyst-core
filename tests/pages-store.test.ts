import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConversationRetentionWorkflow,
  deriveAppContentKey,
  storePageFileSet
} from "@vivd-catalyst/chat-server";
import {
  CONVERSATION_MAX_PAGES,
  FILE_SET_MAX_FILE_BYTES,
  FILE_SET_MAX_FILES,
  FILE_SET_MAX_TOTAL_BYTES,
  PAGE_MAX_FILE_SETS,
  asUserId,
  createFileSetId,
  isAppError,
  readObjectBytes,
  type Conversation,
  type ObjectStorage
} from "@vivd-catalyst/core";
import { createConversationCleanupFixture } from "./support/conversation-cleanup-fixture";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { usePostgresSuite } from "./support/postgres-suite";
import { createTestInstance } from "./support/test-instance";

// The revisions of a Page are file sets that are written once. A save is a new file set under a
// new id; nothing writes to a stored one again, and a file set leaves with its conversation.

const text = (value: string) => new TextEncoder().encode(value);
const file = (path: string, content: string) => ({ path, bytes: text(content) });

const revision = (label: string) => ({
  kitVersion: "1.0.0",
  manifest: { entry: "index.html", label },
  sourceFiles: [file("index.html", `<h1>${label}</h1>`), file("src/main.ts", `// ${label}`)],
  builtFiles: [file("index.html", `<h1>${label}</h1>`), file("assets/main.js", `// ${label}`)]
});

/** An object store whose removals can be made to fail, as a provider that is not reachable. */
class FailingRemovals extends MemoryObjectStorage {
  failRemovals = false;
  override async deletePrefix(prefix: string): Promise<{ deleted: number }> {
    if (this.failRemovals) {
      throw new Error("The object store is not reachable");
    }
    return super.deletePrefix(prefix);
  }
}

async function everyObject(objects: ObjectStorage, prefix = "pages/") {
  const found = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await objects.list(prefix, cursor);
    for (const object of page.objects) {
      found.set(object.key, new TextDecoder().decode(await readObjectBytes(objects, object.key)));
    }
    cursor = page.cursor;
  } while (cursor);
  return found;
}

async function refusalOf(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    if (isAppError(error)) {
      const details: unknown = error.details;
      return {
        code: error.code,
        message: error.message,
        ...(typeof details === "object" && details !== null ? details : {})
      };
    }
    throw error;
  }
  throw new Error("Expected a refusal");
}

describe("the file sets of a Page", () => {
  const db = usePostgresSuite("pages");

  async function arrange(label: string) {
    const fixture = await createConversationCleanupFixture(db, label);
    const objects = new FailingRemovals();
    const options = {
      ...fixture.options,
      pages: { objects, contentKey: deriveAppContentKey("content-secret-".repeat(4)) }
    };
    const author = await fixture.createUser("author");
    const conversation = await fixture.createConversation(author, "pages");
    const save = (name: string, label = name, into: Conversation = conversation) =>
      storePageFileSet(options, {
        conversationId: into.id,
        pageName: name,
        createdByUserId: asUserId(author.id),
        ...revision(label)
      });
    return { fixture, objects, options, author, conversation, save, scope: fixture.scope };
  }

  it("stores every save as a new file set and leaves the stored ones as they are", async () => {
    const { objects, save, scope } = await arrange("immutable");
    const first = await save("Offer", "first");
    const stored = await everyObject(objects);
    const row = await db.sql`select * from file_sets where id = ${first.fileSet.id}`;
    expect([...stored.keys()].sort()).toEqual(
      ["dist/assets/main.js", "dist/index.html", "src/index.html", "src/src/main.ts"].map(
        (path) => `pages/${first.page.id}/${first.fileSet.id}/${path}`
      )
    );

    const second = await save("Offer", "second");
    const third = await save(" Offer ", "third");

    // One Page, three revisions, numbered in the order they were stored.
    expect([second.page.id, third.page.id]).toEqual([first.page.id, first.page.id]);
    expect([first, second, third].map((saved) => saved.fileSet.number)).toEqual([1, 2, 3]);
    expect(new Set([first, second, third].map((saved) => saved.fileSet.id)).size).toBe(3);
    // The first revision: the same row, the same objects, the same bytes.
    expect(await db.sql`select * from file_sets where id = ${first.fileSet.id}`).toEqual(row);
    const after = await everyObject(objects, `pages/${first.page.id}/${first.fileSet.id}/`);
    expect(after).toEqual(stored);
    expect(after.get(`pages/${first.page.id}/${first.fileSet.id}/dist/index.html`)).toBe(
      "<h1>first</h1>"
    );
    // The history is newest first, and the newest is what a read without an id answers.
    const history = await db.store.pages.listPageFileSets({ ...scope, pageId: first.page.id });
    expect(history.map((entry) => entry.number)).toEqual([3, 2, 1]);
    expect((await db.store.pages.getPageFileSet({ ...scope, pageId: first.page.id }))?.id).toBe(
      third.fileSet.id
    );
  });

  it("has no call that changes a stored file set, and refuses to store one id twice", async () => {
    const { save, scope } = await arrange("no_update");
    // What the store offers. A call that changes a file set would have to be added here.
    expect(Object.keys(db.store.pages).sort()).toEqual([
      "createPageFileSet",
      "deletePage",
      "ensurePage",
      "getPage",
      "getPageFileSet",
      "getServedFileSet",
      "listConversationPageIds",
      "listPageFileSets",
      "listPages"
    ]);
    const saved = await save("Offer");
    const sameId = db.store.pages.createPageFileSet({
      ...scope,
      pageId: saved.page.id,
      fileSet: {
        id: saved.fileSet.id,
        kitVersion: "2.0.0",
        manifest: {},
        sourceFiles: [],
        builtFiles: [],
        createdAt: new Date().toISOString()
      }
    });
    await expect(sameId).rejects.toThrow();
    expect(
      await db.store.pages.getPageFileSet({
        ...scope,
        pageId: saved.page.id,
        fileSetId: saved.fileSet.id
      })
    ).toMatchObject({ kitVersion: "1.0.0", number: 1, builtFileCount: 2 });

    // No statement of the product updates the table.
    const sources: string[] = [];
    for (const root of ["packages/postgres-store/src", "packages/chat-server/src"]) {
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          sources.push(await readFile(join(entry.parentPath, entry.name), "utf8"));
        }
      }
    }
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.filter((source) => source.includes("insert(fileSets)"))).toHaveLength(1);
    expect(
      sources.filter((source) => /update\(\s*fileSets\s*\)|update\s+"?file_sets/u.test(source))
    ).toEqual([]);
  });

  it("gives two saves of one Page at the same time two numbers", async () => {
    const { save, scope, conversation } = await arrange("numbering");
    const saved = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => save("Offer", `save ${index}`))
    );

    expect(new Set(saved.map((entry) => entry.page.id)).size).toBe(1);
    expect(saved.map((entry) => entry.fileSet.number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      await db.store.pages.listPages({ ...scope, conversationId: conversation.id })
    ).toHaveLength(1);
  });

  it("refuses a file set over a cap with the name of the cap, and writes nothing", async () => {
    const { objects, options, conversation, scope } = await arrange("caps");
    const store = (sourceFiles: { path: string; bytes: Uint8Array }[]) =>
      storePageFileSet(options, {
        conversationId: conversation.id,
        pageName: "Large",
        kitVersion: "1.0.0",
        manifest: {},
        sourceFiles,
        builtFiles: [file("index.html", "<h1>Large</h1>")]
      });
    const small = (count: number) =>
      Array.from({ length: count }, (_unused, index) => file(`src/file-${index}.ts`, "x"));

    expect(await refusalOf(store(small(FILE_SET_MAX_FILES)))).toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "file_set_too_large",
      cap: "FILE_SET_MAX_FILES",
      limit: 500,
      actual: 501,
      message: expect.stringContaining("at most 500 (FILE_SET_MAX_FILES)")
    });
    expect(
      await refusalOf(
        store([{ path: "src/big.bin", bytes: new Uint8Array(FILE_SET_MAX_FILE_BYTES + 1) }])
      )
    ).toMatchObject({
      reason: "file_set_too_large",
      cap: "FILE_SET_MAX_FILE_BYTES",
      limit: 2 * 1024 * 1024,
      file: "src/big.bin",
      message: expect.stringContaining("at most 2 MB (FILE_SET_MAX_FILE_BYTES)")
    });
    const full = new Uint8Array(FILE_SET_MAX_FILE_BYTES);
    expect(
      await refusalOf(
        store(
          Array.from({ length: 13 }, (_unused, index) => ({
            path: `src/part-${index}.bin`,
            bytes: full
          }))
        )
      )
    ).toMatchObject({
      reason: "file_set_too_large",
      cap: "FILE_SET_MAX_TOTAL_BYTES",
      limit: 25 * 1024 * 1024,
      message: expect.stringContaining("at most 25 MB (FILE_SET_MAX_TOTAL_BYTES)")
    });
    expect(FILE_SET_MAX_TOTAL_BYTES).toBe(25 * 1024 * 1024);

    // Nothing of the three: no Page, no row, no object.
    expect(await db.store.pages.listPages({ ...scope, conversationId: conversation.id })).toEqual(
      []
    );
    expect((await everyObject(objects)).size).toBe(0);

    // A file set at the cap is stored.
    const atCap = await store(small(FILE_SET_MAX_FILES - 1));
    expect(atCap.fileSet).toMatchObject({ sourceFileCount: 499, builtFileCount: 1 });
    expect((await everyObject(objects)).size).toBe(FILE_SET_MAX_FILES);
  });

  it("refuses a path that leaves the file set or takes the platform's own place", async () => {
    const { objects, options, conversation } = await arrange("paths");
    const paths = [
      "../index.html",
      "/index.html",
      "assets//main.js",
      "assets/./main.js",
      "assets/..",
      "",
      "__catalyst/guard-1.js",
      "__Catalyst/guard-1.js",
      // At every depth: an HTML file in a folder resolves a relative address below that folder.
      "sub/__catalyst/guard-1.js",
      "sub/deeper/__CATALYST/relay.js",
      "sub/__catalyst",
      "assets/a?b.js",
      "assets/a%2fb.js",
      "assets\\main.js"
    ];
    for (const path of paths) {
      const refusal = await refusalOf(
        storePageFileSet(options, {
          conversationId: conversation.id,
          pageName: "Paths",
          kitVersion: "1.0.0",
          manifest: {},
          sourceFiles: [],
          builtFiles: [file("index.html", "<h1>x</h1>"), file(path, "x")]
        })
      );
      expect(refusal, path).toMatchObject({ reason: "file_set_invalid" });
    }
    const twice = await refusalOf(
      storePageFileSet(options, {
        conversationId: conversation.id,
        pageName: "Paths",
        kitVersion: "1.0.0",
        manifest: {},
        sourceFiles: [],
        builtFiles: [file("Index.html", "a"), file("index.html", "b")]
      })
    );
    expect(twice).toMatchObject({ reason: "file_set_invalid", file: "index.html" });
    expect((await everyObject(objects)).size).toBe(0);
  });

  it("refuses markup that declares a shadow tree, which the Page's guard would not see", async () => {
    const { objects, options, conversation } = await arrange("shadow_tree");
    const store = (path: string, content: string) =>
      storePageFileSet(options, {
        conversationId: conversation.id,
        pageName: "Shadow",
        kitVersion: "1.0.0",
        manifest: {},
        sourceFiles: [],
        builtFiles: [file("index.html", "<h1>x</h1>"), file(path, content)]
      });
    const link = '<a href="https://other.example.test/">Open</a>';

    for (const markup of [
      `<div><template shadowrootmode="closed">${link}</template></div>`,
      `<div><template SHADOWROOTMODE=open>${link}</template></div>`,
      `<div><template shadowroot="closed">${link}</template></div>`
    ]) {
      expect(await refusalOf(store("view.html", markup)), markup).toMatchObject({
        reason: "file_set_invalid",
        file: "view.html",
        message: expect.stringContaining("shadowrootmode")
      });
    }
    expect((await everyObject(objects)).size).toBe(0);
    // A script may hold the word: it attaches its trees through a call the guard watches.
    const stored = await store(
      "assets/main.js",
      'host.attachShadow({ mode: "closed" }); // shadowrootmode'
    );
    expect(stored.fileSet.builtFileCount).toBe(2);
  });

  it("removes the objects of a save whose row could not be written", async () => {
    const { objects, save, scope, conversation } = await arrange("failed_row");
    const kept = await save("Offer", "kept");
    const createPageFileSet = db.store.pages.createPageFileSet;
    db.store.pages.createPageFileSet = async () => {
      // The objects are there when the row is written.
      expect((await everyObject(objects)).size).toBe(8);
      throw new Error("The database is not reachable");
    };
    try {
      await expect(save("Offer", "lost")).rejects.toThrow("The database is not reachable");
    } finally {
      db.store.pages.createPageFileSet = createPageFileSet;
    }

    expect(
      [...(await everyObject(objects)).keys()].every((key) => key.includes(kept.fileSet.id))
    ).toBe(true);
    expect((await everyObject(objects)).size).toBe(4);
    expect(
      (await db.store.pages.listPageFileSets({ ...scope, pageId: kept.page.id })).map(
        (entry) => entry.id
      )
    ).toEqual([kept.fileSet.id]);
    expect(conversation.id).toBe(kept.page.conversationId);
  });

  it("stores nothing for a conversation that is deleted", async () => {
    const { objects, options, save, conversation, author } = await arrange("deleted_target");
    const api = await createTestInstance({ server: options });
    await api.call(
      "conversations.delete",
      { params: { conversationId: conversation.id } },
      author.id
    );

    expect(await refusalOf(save("Offer"))).toMatchObject({ code: "NOT_FOUND" });
    expect((await everyObject(objects)).size).toBe(0);
  });

  it(`keeps at most ${PAGE_MAX_FILE_SETS} revisions of a Page and ${CONVERSATION_MAX_PAGES} Pages of a conversation`, async () => {
    const { save, scope, conversation } = await arrange("limits");
    const { page } = await save("Offer");
    const add = () =>
      db.store.pages.createPageFileSet({
        ...scope,
        pageId: page.id,
        fileSet: {
          id: createFileSetId(),
          kitVersion: "1.0.0",
          manifest: {},
          sourceFiles: [],
          builtFiles: [],
          createdAt: new Date().toISOString()
        }
      });
    for (let stored = 1; stored < PAGE_MAX_FILE_SETS; stored += 1) {
      await add();
    }
    expect(await refusalOf(add())).toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_revision_limit",
      limit: PAGE_MAX_FILE_SETS,
      message: expect.stringContaining("PAGE_MAX_FILE_SETS")
    });
    expect(await refusalOf(save("Offer"))).toMatchObject({ reason: "page_revision_limit" });
    const history = await db.store.pages.listPageFileSets({ ...scope, pageId: page.id });
    expect(history).toHaveLength(PAGE_MAX_FILE_SETS);
    expect(history[0]?.number).toBe(PAGE_MAX_FILE_SETS);

    const ensure = (name: string) =>
      db.store.pages.ensurePage({
        ...scope,
        conversationId: conversation.id,
        name,
        createdAt: new Date().toISOString()
      });
    for (let held = 1; held < CONVERSATION_MAX_PAGES; held += 1) {
      await ensure(`Page ${held}`);
    }
    expect(await refusalOf(ensure("One too many"))).toMatchObject({
      reason: "page_limit",
      limit: CONVERSATION_MAX_PAGES,
      message: expect.stringContaining("CONVERSATION_MAX_PAGES")
    });
    // A name the conversation already has is not a new Page.
    expect((await ensure("Page 1")).name).toBe("Page 1");
  }, 120_000);

  it("removes the rows and objects of a deleted conversation and of no other", async () => {
    const { fixture, objects, options, save, conversation, author, scope } =
      await arrange("cleanup");
    const other = await fixture.createConversation(author, "other");
    const first = await save("Offer");
    await save("Offer", "second");
    const sibling = await save("Appendix");
    const kept = await save("Kept", "kept", other);
    expect((await everyObject(objects)).size).toBe(16);

    const api = await createTestInstance({ server: options });
    const deletion = await api.call(
      "conversations.delete",
      { params: { conversationId: conversation.id } },
      author.id
    );
    expect(deletion.statusCode).toBe(200);

    expect(
      [...(await everyObject(objects)).keys()].every((key) => key.includes(kept.page.id))
    ).toBe(true);
    expect((await everyObject(objects)).size).toBe(4);
    const pageIds = [first.page.id, sibling.page.id];
    expect(await db.sql`select id from pages where id in ${db.sql(pageIds)}`).toHaveLength(0);
    expect(
      await db.sql`select id from file_sets where owner_id in ${db.sql(pageIds)}`
    ).toHaveLength(0);
    expect(await db.sql`select id from file_sets where owner_id = ${kept.page.id}`).toHaveLength(1);
    expect(await fixture.pending()).toEqual([]);
    expect(
      await db.store.pages.getServedFileSet({ ...scope, fileSetId: first.fileSet.id })
    ).toBeUndefined();
    expect(
      (await db.store.pages.getServedFileSet({ ...scope, fileSetId: kept.fileSet.id }))?.id
    ).toBe(kept.fileSet.id);
  });

  it("serves nothing of a conversation whose cleanup failed, and finishes the cleanup later", async () => {
    const { fixture, objects, options, save, conversation, author, scope } =
      await arrange("cleanup_retry");
    const saved = await save("Offer");
    const api = await createTestInstance({ server: options });

    objects.failRemovals = true;
    const deletion = await api.call(
      "conversations.delete",
      { params: { conversationId: conversation.id } },
      author.id
    );
    expect(deletion.statusCode).toBe(200);

    // Rows and objects are left, the conversation is listed for the retry, nothing is served.
    expect((await everyObject(objects)).size).toBe(4);
    expect(await fixture.pending()).toEqual([conversation.id]);
    expect(
      await db.store.pages.getServedFileSet({ ...scope, fileSetId: saved.fileSet.id })
    ).toBeUndefined();

    objects.failRemovals = false;
    const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
    await new ConversationRetentionWorkflow(options).run(silent);
    expect((await everyObject(objects)).size).toBe(0);
    expect(await fixture.pending()).toEqual([]);
    expect(await db.sql`select id from pages where id = ${saved.page.id}`).toHaveLength(0);
    expect(await db.sql`select id from file_sets where id = ${saved.fileSet.id}`).toHaveLength(0);
  });
});
