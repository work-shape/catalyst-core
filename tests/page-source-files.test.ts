import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveAppContentKey, storePageFileSet } from "@vivd-catalyst/chat-server";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { asClientInstanceId, asConversationId } from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { createTestInstanceWith } from "./support/test-instance";

// The source files of a Page revision are listed for the people who may read the conversation
// the Page belongs to: path, type, size and hash, never content. The hash is what tells the
// file a revision changed from the files it took over.
// Every test here fails without `pages.files.list`: the operation did not exist.

const text = (value: string) => new TextEncoder().encode(value);
const sourceFiles = [
  { path: "src/routes/index.tsx", bytes: text("export const Route = 1;\n") },
  { path: "app.yaml", bytes: text("name: Offer\n") },
  { path: "src/main.ts", bytes: text("document.body.dataset.ready = 'true';\n") }
];
const builtFiles = [{ path: "index.html", bytes: text("<!doctype html><title>Offer</title>") }];

async function startInstance(appsEnabled = true) {
  const config = parseClientInstanceConfig({
    ...createTestConfig(),
    modules: { apps: { enabled: appsEnabled } }
  });
  const pages = {
    objects: new MemoryObjectStorage(),
    contentKey: deriveAppContentKey("content-secret-".repeat(4))
  };
  const instance = await createTestInstanceWith(() => ({
    config,
    modules: resolveInstanceModules(config).snapshot,
    pages
  }));
  return {
    instance,
    context: {
      clientInstanceId: asClientInstanceId(config.clientInstance.id),
      stores: instance.stores,
      pages
    }
  };
}

async function withPage({ instance, context }: Awaited<ReturnType<typeof startInstance>>) {
  const created = await instance.call(
    "conversations.create",
    { payload: { title: "Pages" } },
    "user-1"
  );
  const conversationId = asConversationId(created.json<{ id: string }>().id);
  const stored = await storePageFileSet(context, {
    conversationId,
    pageName: "Offer",
    kitVersion: "1.0.0",
    manifest: { entry: "index.html" },
    sourceFiles,
    builtFiles
  });
  return {
    conversationId,
    params: { conversationId, pageId: stored.page.id, fileSetId: stored.fileSet.id }
  };
}

describe("pages.files.list", () => {
  it("lists the source files of a revision by path, with size and hash and without content", async () => {
    const started = await startInstance();
    const { params } = await withPage(started);

    const listed = await started.instance.call("pages.files.list", { params }, "user-1");

    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ files: object[] }>().files).toEqual(
      ["app.yaml", "src/main.ts", "src/routes/index.tsx"].map((path) => {
        const source = sourceFiles.find((file) => file.path === path);
        return {
          path,
          contentType: expect.any(String),
          bytes: source?.bytes.byteLength,
          sha256: createHash("sha256")
            .update(source?.bytes ?? "")
            .digest("hex")
        };
      })
    );
    // No built file is a source file, and a listing holds no line of any file.
    expect(listed.body).not.toContain("index.html");
    expect(listed.body).not.toContain("dataset");
  });

  it("answers someone who may not read the conversation as if there were no Page", async () => {
    const started = await startInstance();
    const { params } = await withPage(started);

    const refused = await started.instance.call("pages.files.list", { params }, "user-2");

    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain("src/main.ts");
  });

  it("answers a revision of another Page with 404", async () => {
    const started = await startInstance();
    const first = await withPage(started);
    const second = await withPage(started);

    const foreign = await started.instance.call(
      "pages.files.list",
      { params: { ...first.params, fileSetId: second.params.fileSetId } },
      "user-1"
    );

    expect(foreign.statusCode).toBe(404);
  });

  it("answers 404 module_off with the apps module off", async () => {
    const on = await startInstance();
    const { params } = await withPage(on);
    await on.instance.close();

    const off = await startInstance(false);
    const answer = await off.instance.call("pages.files.list", { params }, "user-1");

    expect(answer.statusCode).toBe(404);
    expect(answer.json()).toMatchObject({
      error: { details: { reason: "module_off", module: "apps" } }
    });
  });
});
