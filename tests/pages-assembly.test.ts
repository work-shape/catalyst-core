import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storePageFileSet } from "@vivd-catalyst/chat-server";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { asClientInstanceId, asConversationId } from "@vivd-catalyst/core";
import { createFilesystemObjectStorage } from "@vivd-catalyst/object-storage";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

// What an instance assembled from its configuration does with Pages: what it needs to start
// with the apps module on, what it still does for the Pages it holds with the module off, and
// how the proxy the repository ships routes the content route.

const text = (value: string) => new TextEncoder().encode(value);
/** Where the filesystem store of an assembled test instance would keep its files. */
const filesRoot = join(tmpdir(), "catalyst-app-content-test-files");
const INDEX_HTML = `<!doctype html><title>Offer</title><script type="module" src="./assets/main.js"></script>`;
const builtFiles = [
  { path: "index.html", bytes: text(INDEX_HTML) },
  { path: "assets/main.js", bytes: text(`document.body.dataset.ready = "true";\n`) }
];
const sourceFiles = [{ path: "index.html", bytes: text(INDEX_HTML) }];

interface ErrorBody {
  error: { code: string; message: string; details?: { reason?: string } };
}

describe("an assembled instance with the apps module on", () => {
  const config = (files: boolean) =>
    parseClientInstanceConfig({
      ...createTestConfig(),
      modules: { apps: { enabled: true } },
      infrastructure: {
        ...createTestConfig().infrastructure,
        ...(files ? { objectStorage: { files: { provider: "filesystem", root: filesRoot } } } : {})
      }
    });
  const secret = "a-secret-of-the-instance-with-enough-characters";

  it("does not start without the store its Pages keep their files in", async () => {
    await expect(
      createTestInstance({ config: config(false), env: { BETTER_AUTH_SECRET: secret }, tools: [] })
    ).rejects.toThrow(
      "'modules.apps.enabled' is true, but 'infrastructure.objectStorage.files' is not configured"
    );
  });

  it("does not start without a secret to derive the key of its content tokens from", async () => {
    await expect(createTestInstance({ config: config(true), env: {}, tools: [] })).rejects.toThrow(
      /neither of the secrets 'CHAT_SESSION_TOKEN_SECRET' and 'BETTER_AUTH_SECRET'/u
    );
    // A secret too short to sign with is no secret.
    await expect(
      createTestInstance({ config: config(true), env: { BETTER_AUTH_SECRET: "short" }, tools: [] })
    ).rejects.toThrow(/at least 32 characters/u);
  });

  it("starts with both and answers the Pages of a conversation", async () => {
    const instance = await createTestInstance({
      config: config(true),
      env: { BETTER_AUTH_SECRET: secret },
      tools: []
    });
    const created = await instance.call("conversations.create", { payload: { title: "Pages" } });
    const listed = await instance.call("pages.list", {
      params: { conversationId: created.json<{ id: string }>().id }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [] });
  });
});

describe("an assembled instance with the apps module off", () => {
  const identity = (id: string, roles = ["user"]) => ({
    id,
    externalUserId: id,
    displayLabel: id,
    email: `${id}@example.test`,
    emailVerified: true,
    roles,
    permissionRefs: ["demo-tools"]
  });

  it("removes the Pages of a deleted conversation, workspace and user all the same", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalyst-pages-module-off-"));
    const base = createTestConfig({
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [identity("owner", ["user", "admin", "superadmin"]), identity("member")]
      }
    });
    const config = parseClientInstanceConfig({
      ...base,
      modules: { apps: { enabled: false } },
      infrastructure: {
        ...base.infrastructure,
        objectStorage: { files: { provider: "filesystem", root } }
      }
    });
    // No secret: with the module off none is read, and the instance starts.
    const instance = await createTestInstance({ config, env: {}, tools: [] });
    // The Pages of a time the module was on, in the store the instance still has.
    const context = {
      clientInstanceId: asClientInstanceId(config.clientInstance.id),
      stores: instance.stores,
      pages: { objects: createFilesystemObjectStorage(root) }
    };
    const signedIn = async (user: string) => {
      const me = await instance.call("me.get", {}, user);
      expect((await instance.call("workspaces.ensure_personal", {}, user)).statusCode).toBe(200);
      return me.json<{ id: string }>().id;
    };
    const conversationWithPage = async (user: string, collaborationWorkspaceId?: string) => {
      const created = await instance.call(
        "conversations.create",
        {
          payload: {
            title: "Pages",
            ...(collaborationWorkspaceId ? { collaborationWorkspaceId } : {})
          }
        },
        user
      );
      expect(created.statusCode).toBe(200);
      const conversationId = asConversationId(created.json<{ id: string }>().id);
      const stored = await storePageFileSet(context, {
        conversationId,
        pageName: "Offer",
        kitVersion: "1.0.0",
        manifest: { entry: "index.html" },
        sourceFiles,
        builtFiles
      });
      return { conversationId, pageId: stored.page.id };
    };
    const storedPages = () => readdir(join(root, "pages")).catch(() => []);
    const pagesOf = (conversationId: ReturnType<typeof asConversationId>) =>
      instance.stores.pages.listConversationPageIds({
        clientInstanceId: context.clientInstanceId,
        conversationId
      });

    await signedIn("owner");
    const memberId = await signedIn("member");
    const workspace = await instance.call(
      "workspaces.create",
      { payload: { name: "Shared" } },
      "owner"
    );
    const collaborationWorkspaceId = workspace.json<{ id: string }>().id;
    const own = await conversationWithPage("owner");
    const shared = await conversationWithPage("owner", collaborationWorkspaceId);
    const members = await conversationWithPage("member");
    expect((await storedPages()).sort()).toEqual(
      [own.pageId, shared.pageId, members.pageId].sort()
    );

    // The module is off: the Pages are not served, listed or previewed.
    const listed = await instance.call(
      "pages.list",
      { params: { conversationId: own.conversationId } },
      "owner"
    );
    expect(listed.json<ErrorBody>().error.details).toEqual({
      reason: "module_off",
      module: "apps"
    });

    const conversationDeleted = await instance.call(
      "conversations.delete",
      { params: { conversationId: own.conversationId } },
      "owner"
    );
    expect(conversationDeleted.statusCode).toBe(200);
    expect(await pagesOf(own.conversationId)).toEqual([]);
    expect((await storedPages()).sort()).toEqual([shared.pageId, members.pageId].sort());

    const workspaceDeleted = await instance.call(
      "workspaces.delete",
      { params: { collaborationWorkspaceId }, payload: { confirmName: "Shared" } },
      "owner"
    );
    expect(workspaceDeleted.statusCode).toBe(200);
    expect(await pagesOf(shared.conversationId)).toEqual([]);
    expect(await storedPages()).toEqual([members.pageId]);

    const userDeleted = await instance.call(
      "users.delete",
      { params: { userId: memberId } },
      "owner"
    );
    expect(userDeleted.statusCode).toBe(200);
    expect(await pagesOf(members.conversationId)).toEqual([]);
    expect(await storedPages()).toEqual([]);
  });
});

describe("the proxy configuration the repository ships", () => {
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

  it("sends the content route to the API wherever it sends the view runtime there", async () => {
    for (const path of ["docker/Caddyfile", "clients/demo/deploy/Caddyfile"]) {
      const caddy = await read(path);
      const routed = (prefix: string) =>
        new RegExp(
          `handle ${prefix}/\\* \\{\\s*reverse_proxy api:4100\\s*\\}|reverse_proxy ${prefix}/\\* api:4100`,
          "u"
        ).test(caddy);
      expect(routed("/app-runtime"), path).toBe(true);
      expect(routed("/app-content"), path).toBe(true);
      // The address of a Page file holds a token, so the proxy keeps no access log.
      expect(caddy, path).not.toMatch(/^\s*log\b/mu);
    }
  });

  it("neither answers the content route with the interface nor logs its addresses there", async () => {
    const nginx = await read("docker/nginx-spa.conf");
    const location = /location \/app-content \{([^}]*)\}/u.exec(nginx)?.[1] ?? "";
    expect(location).toContain("access_log off;");
    expect(location).toContain("return 404;");
    // Before the catch-all that answers every other address with the interface.
    expect(nginx.indexOf("location /app-content")).toBeLessThan(nginx.indexOf("location / {"));
  });
});
