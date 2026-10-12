import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_CONTENT_VIEWER_CHECK_MAX_ENTRIES,
  APP_CONTENT_VIEWER_CHECK_SECONDS,
  createAppContentViewerChecks,
  deriveAppContentKey,
  storePageFileSet
} from "@vivd-catalyst/chat-server";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { asClientInstanceId, asConversationId, asUserId } from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { callTestPath, createTestInstanceWith } from "./support/test-instance";

// The address of a Page names the viewer it was made for, and it serves only while that viewer
// may still read the Page. The answer is kept per token for a window, so an address stops at
// most one window after its viewer lost access, and a Page load asks once.

const text = (value: string) => new TextEncoder().encode(value);
const MAIN_JS = `document.body.dataset.ready = "true";\n`;
const INDEX_HTML = `<!doctype html><title>Offer</title><script type="module" src="./assets/main.js"></script>`;
const builtFiles = [
  { path: "index.html", bytes: text(INDEX_HTML) },
  { path: "assets/main.js", bytes: text(MAIN_JS) }
];
const sourceFiles = [{ path: "index.html", bytes: text(INDEX_HTML) }];
const asScript = { "sec-fetch-dest": "script" };
const asFrame = { "sec-fetch-dest": "iframe" };
const WINDOW_MS = APP_CONTENT_VIEWER_CHECK_SECONDS * 1000;

interface ErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: { reason?: string };
  };
}

/**
 * An instance whose people are plain users, so that a workspace is read by its members only.
 * `owner` holds a shared workspace with one conversation and one Page; `member` is a member.
 */
async function arrange() {
  const config = parseClientInstanceConfig({
    ...createTestConfig(),
    modules: { apps: { enabled: true } }
  });
  const clientInstanceId = asClientInstanceId(config.clientInstance.id);
  const pages = {
    objects: new MemoryObjectStorage(),
    contentKey: deriveAppContentKey("content-secret-".repeat(4))
  };
  const instance = await createTestInstanceWith((stores) => ({
    config,
    modules: resolveInstanceModules(config, []).snapshot,
    pages,
    allowedOrigins: ["https://ui.example.test"],
    authAdapter: {
      id: "test",
      credentialMode: "ambient",
      async authenticate(request) {
        const actor = request.headers["x-dev-user-id"];
        const externalUserId = typeof actor === "string" ? actor : "owner";
        return {
          ...(await stores.users.resolveUserIdentity({
            clientInstanceId,
            authSource: "test",
            externalUserId,
            displayLabel: externalUserId,
            email: `${externalUserId}@example.test`,
            emailVerified: true,
            roles: ["user"],
            permissionRefs: [],
            permissions: [],
            correlationId: "test"
          })),
          scopes: ["*"]
        };
      }
    }
  }));

  const userIdOf = async (who: string) =>
    asUserId((await instance.call("me.get", {}, who)).json<{ id: string }>().id);
  const ownerId = await userIdOf("owner");
  const memberId = await userIdOf("member");
  const workspace = await instance.call("workspaces.create", { payload: { name: "Lab" } }, "owner");
  const collaborationWorkspaceId = workspace.json<{ id: string }>().id;
  const added = await instance.call(
    "workspaces.members.add",
    { params: { collaborationWorkspaceId }, payload: { email: "member@example.test" } },
    "owner"
  );
  expect(added.statusCode).toBe(200);
  const created = await instance.call(
    "conversations.create",
    { payload: { title: "Pages", collaborationWorkspaceId } },
    "owner"
  );
  const conversationId = asConversationId(created.json<{ id: string }>().id);
  const stored = await storePageFileSet(
    { clientInstanceId, stores: instance.stores, pages },
    {
      conversationId,
      pageName: "Offer",
      kitVersion: "1.0.0",
      manifest: { entry: "index.html" },
      sourceFiles,
      builtFiles
    }
  );

  /** The address a person is given for the Page, minted while they may read it. */
  const addressFor = async (who: string) => {
    const preview = await instance.call(
      "pages.preview",
      { params: { conversationId, pageId: stored.page.id }, payload: {} },
      who
    );
    expect(preview.statusCode).toBe(200);
    return preview.json<{ url: string }>().url;
  };
  const load = (url: string, path = "assets/main.js") =>
    callTestPath(instance, "GET", `${url}${path}`, path === "" ? asFrame : asScript);
  /** What a refusal says: every header and the body, without what names the one request. */
  const refusalOf = async (url: string) => {
    const response = await load(url);
    const { correlationId, ...error } = response.json<ErrorBody>().error;
    expect(correlationId).toMatch(/^corr_/u);
    const { date, "x-correlation-id": requestId, ...headers } = response.headers;
    expect([typeof date, requestId]).toEqual(["string", correlationId]);
    return { status: response.statusCode, error, headers };
  };
  return {
    instance,
    clientInstanceId,
    collaborationWorkspaceId,
    conversationId,
    ownerId,
    memberId,
    addressFor,
    load,
    refusalOf
  };
}

/** Holds the clock at now. Only `Date` is replaced, so the database is waited for as ever. */
function holdClock(): number {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now();
  vi.setSystemTime(now);
  return now;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the viewer of a content token", () => {
  it("is served no longer than one window after being removed from the workspace", async () => {
    const page = await arrange();
    const memberUrl = await page.addressFor("member");
    const ownerUrl = await page.addressFor("owner");
    const start = holdClock();
    expect((await page.load(memberUrl)).statusCode).toBe(200);

    const removed = await page.instance.call(
      "workspaces.members.remove",
      {
        params: { collaborationWorkspaceId: page.collaborationWorkspaceId, userId: page.memberId }
      },
      "owner"
    );
    expect(removed.statusCode).toBe(200);

    // The answer of a moment ago is kept until the window is over, and no longer.
    vi.setSystemTime(start + WINDOW_MS - 1000);
    expect((await page.load(memberUrl)).statusCode).toBe(200);
    vi.setSystemTime(start + WINDOW_MS);
    const refused = await page.refusalOf(memberUrl);
    expect(refused).toMatchObject({
      status: 404,
      error: { code: "NOT_FOUND", details: { reason: "file_set_unknown" } },
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" }
    });
    // The document is refused like every file it would load.
    expect((await page.load(memberUrl, "")).statusCode).toBe(404);
    // Another viewer of the same Page is served as before.
    const served = await page.load(ownerUrl);
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe(MAIN_JS);

    // The refusal is the answer of an address whose file set does not exist, header for
    // header: the owner's address after the conversation is gone.
    const deleted = await page.instance.call(
      "conversations.delete",
      { params: { conversationId: page.conversationId } },
      "owner"
    );
    expect(deleted.statusCode).toBe(200);
    expect(await page.refusalOf(ownerUrl)).toEqual(refused);
  });

  it("is served no longer than one window after the account is deactivated", async () => {
    const page = await arrange();
    const memberUrl = await page.addressFor("member");
    const ownerUrl = await page.addressFor("owner");
    const start = holdClock();
    expect((await page.load(memberUrl)).statusCode).toBe(200);

    await page.instance.stores.users.updateUser({
      clientInstanceId: page.clientInstanceId,
      userId: page.memberId,
      status: "disabled"
    });

    vi.setSystemTime(start + WINDOW_MS);
    expect(await page.refusalOf(memberUrl)).toMatchObject({
      status: 404,
      error: { details: { reason: "file_set_unknown" } }
    });
    expect((await page.load(ownerUrl)).statusCode).toBe(200);

    // A token that is first used after the deactivation serves nothing: nothing is kept for it.
    await page.instance.stores.users.updateUser({
      clientInstanceId: page.clientInstanceId,
      userId: page.ownerId,
      status: "disabled"
    });
    vi.setSystemTime(start + 2 * WINDOW_MS);
    expect((await page.refusalOf(ownerUrl)).status).toBe(404);
  });

  it("is refused at once when the conversation of the Page is deleted", async () => {
    const page = await arrange();
    const memberUrl = await page.addressFor("member");
    holdClock();
    expect((await page.load(memberUrl)).statusCode).toBe(200);

    const deleted = await page.instance.call(
      "conversations.delete",
      { params: { conversationId: page.conversationId } },
      "owner"
    );
    expect(deleted.statusCode).toBe(200);
    // Inside the window: a kept permission does not serve a conversation that is gone.
    expect(await page.refusalOf(memberUrl)).toMatchObject({
      status: 404,
      error: { details: { reason: "file_set_unknown" } }
    });
  });

  it("is checked once per window, however many files a Page load asks for", async () => {
    const page = await arrange();
    const memberUrl = await page.addressFor("member");
    const ownerUrl = await page.addressFor("owner");
    const start = holdClock();
    const userReads = vi.spyOn(page.instance.stores.users, "getUser");
    const memberships = vi.spyOn(page.instance.stores.workspaces, "getMembership");

    // The document, then forty file requests that arrive together, as a browser sends them.
    expect((await page.load(memberUrl, "")).statusCode).toBe(200);
    const files = await Promise.all(Array.from({ length: 40 }, () => page.load(memberUrl)));
    expect(files.map((file) => file.statusCode)).toEqual(Array.from({ length: 40 }, () => 200));
    expect(userReads).toHaveBeenCalledTimes(1);
    expect(memberships).toHaveBeenCalledTimes(1);

    // Requests that arrive together before any answer is kept share one check as well.
    await Promise.all(Array.from({ length: 10 }, () => page.load(ownerUrl)));
    expect(userReads).toHaveBeenCalledTimes(2);

    vi.setSystemTime(start + WINDOW_MS - 1000);
    expect((await page.load(memberUrl)).statusCode).toBe(200);
    expect(userReads).toHaveBeenCalledTimes(2);
    // The next window asks again, once, and the viewer who kept access is still served.
    vi.setSystemTime(start + WINDOW_MS);
    await Promise.all(Array.from({ length: 5 }, () => page.load(memberUrl)));
    expect((await page.load(memberUrl)).statusCode).toBe(200);
    expect(userReads).toHaveBeenCalledTimes(3);
    expect(memberships).toHaveBeenCalledTimes(3);
  });
});

describe("the kept answers of the viewer check", () => {
  it("holds no more tokens than its limit and asks again for one it let go", async () => {
    const checks = createAppContentViewerChecks();
    const asked: string[] = [];
    const allows = (token: string, nowSeconds = 0) =>
      checks.allows(token, nowSeconds, () => {
        asked.push(token);
        return Promise.resolve(true);
      });

    for (let index = 0; index < APP_CONTENT_VIEWER_CHECK_MAX_ENTRIES; index += 1) {
      await allows(`token-${index}`);
    }
    await allows("token-0");
    expect(asked).toHaveLength(APP_CONTENT_VIEWER_CHECK_MAX_ENTRIES);

    // One more token than the limit: the oldest answer goes, every other one is kept.
    await allows("one-more");
    await allows("token-1");
    await allows("one-more");
    expect(asked).toHaveLength(APP_CONTENT_VIEWER_CHECK_MAX_ENTRIES + 1);
    await allows("token-0");
    expect(asked.at(-1)).toBe("token-0");
    expect(asked).toHaveLength(APP_CONTENT_VIEWER_CHECK_MAX_ENTRIES + 2);
  });

  it("keeps a refusal for the window and does not keep a check that failed", async () => {
    const checks = createAppContentViewerChecks();
    let asked = 0;
    const answer = (allowed: boolean) => () => {
      asked += 1;
      return Promise.resolve(allowed);
    };
    expect(await checks.allows("token", 100, answer(false))).toBe(false);
    expect(await checks.allows("token", 129, answer(true))).toBe(false);
    expect(await checks.allows("token", 130, answer(true))).toBe(true);
    expect(asked).toBe(2);

    await expect(
      checks.allows("other", 100, () => Promise.reject(new Error("database is away")))
    ).rejects.toThrow("database is away");
    expect(await checks.allows("other", 100, answer(true))).toBe(true);
    expect(asked).toBe(3);
  });
});
