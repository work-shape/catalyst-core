import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ASSET_OWNER_KINDS,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  defineAssetKind,
  isFileSetId,
  type JsonObject,
  type PreviewReport,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { createPlatformAssetCalls, workflowAssetKindOf } from "@work-shape/catalyst-server";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { callTestPath, testServerOptions } from "./support/test-instance";

// The preview of an asset's draft, for a kind that brings one (EW-9c2): a writer of the asset
// is given the address of a frame, which answers the kind's own document under the guard and
// the policy of a Page, the files the kind brings, and of the revision's own files only its
// style sheets, images and fonts. The preview reaches nothing else and makes no call.

const KIND = "sample_page";
const KIT_SCRIPT = `document.body.dataset.kit = "ready";\n`;
const text = (value: string) => new TextEncoder().encode(value);

const sampleKind = workflowAssetKindOf({
  ...defineAssetKind({
    kind: KIND,
    plural: "sample_pages",
    schema: z.object({ name: z.string(), title: z.string() }),
    nameRule: { pattern: /^[a-z][a-z0-9-]*$/u, maxLength: 64, description: "lowercase" },
    actions: {
      read: "app.read",
      write: "app.write",
      delete: "app.delete",
      publish: "app.publish",
      approve: "app.approve"
    },
    lifecycle: "draft_published",
    representation: "files",
    manifestFile: "page.yaml",
    owners: [...ASSET_OWNER_KINDS],
    validate: () => [],
    summarize: (page) => ({ name: page.name, title: page.title })
  }),
  references: () => [],
  manifestOfFiles: (files): JsonObject => ({
    title: "Sample </script><b>",
    stylesheet: files.some((file) => file.path === "theme.css")
  }),
  configOfFiles: ({ name, manifest }) => ({ name, title: String(manifest.title) }),
  preview: {
    document: ({ manifest }) =>
      Promise.resolve(
        `<!doctype html><title>Preview</title><script type="module" src="./_kit/main.js"></script>` +
          `<script type="application/json" id="data">${JSON.stringify(manifest).replaceAll("<", "\\u003c")}</script>`
      ),
    files: new Map([
      ["_kit/main.js", { contentType: "text/javascript; charset=utf-8", bytes: text(KIT_SCRIPT) }]
    ])
  }
});

const LOGO = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>";
const files = [
  { path: "page.yaml", text: "title: Sample\n" },
  { path: "theme.css", text: "body { color: rgb(1, 2, 3); }" },
  { path: "assets/logo.svg", text: LOGO },
  { path: "assets/page.html", text: "<!doctype html><p>not served</p>" },
  { path: "assets/data.json", text: "{}" }
];

const previewSchema = z.object({
  url: z.string(),
  fileSetId: z.string(),
  pageSessionId: z.string(),
  revision: z.number()
});

describe("the preview of a draft of a kind that brings one", () => {
  let t: AppInstance;
  let draft: z.infer<typeof previewSchema>;
  const get = (path: string, destination: string) =>
    callTestPath(t.instance, "GET", `${draft.url}${path}`, { "sec-fetch-dest": destination });

  beforeAll(async () => {
    t = await setupAppInstance({ furtherKinds: [sampleKind] });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: KIND, name: "look" },
      payload: { expectedRevision: null, files }
    });
    draft = previewSchema.parse(
      (
        await t.expectOk(t.admin.id, "assets.preview", {
          params: { kind: KIND, name: "look" },
          payload: {}
        })
      ).json()
    );
  });
  afterAll(() => t.close());

  it("answers the kind's document in the frame of a Page, which connects to nothing", async () => {
    const opened = await t.open(draft.url);
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("_kit/main.js");
    // The manifest the kind put into its document cannot end the element that holds it.
    expect(opened.body).not.toContain("</script><b>");
    expect(opened.policy).toContain("sandbox allow-scripts");
    expect(opened.policy).toContain("connect-src 'none'");
    expect(opened.policy).toContain("form-action 'none'");
    expect(opened.policy).toContain("frame-src 'none'");
  });

  it("serves the kind's files and the draft's style sheet and images, and nothing else", async () => {
    const script = await get("_kit/main.js", "script");
    expect(script.statusCode).toBe(200);
    expect(script.body).toBe(KIT_SCRIPT);
    expect((await get("theme.css", "style")).statusCode).toBe(200);
    expect((await get("assets/logo.svg", "image")).body).toBe(LOGO);
    for (const path of ["page.yaml", "assets/page.html", "assets/data.json", "missing.css"]) {
      expect((await get(path, "script")).statusCode, path).toBe(404);
    }
    // An image opened as a document would be a page under the instance's address.
    expect((await get("assets/logo.svg", "document")).statusCode).toBe(403);
    expect((await get("_kit/main.js", "document")).statusCode).toBe(403);
  });

  it("is given only to a writer of the asset, and only for a kind that brings one", async () => {
    expectStatus(
      await t.call(t.lena.id, "assets.preview", {
        params: { kind: KIND, name: "look" },
        payload: {}
      }),
      403
    );
    expectStatus(
      await t.call(t.admin.id, "assets.preview", {
        params: { kind: KIND, name: "missing" },
        payload: {}
      }),
      404
    );
    expectStatus(
      await t.call(t.admin.id, "assets.preview", {
        params: { kind: "agent", name: "look" },
        payload: {}
      }),
      404
    );
  });

  it("keeps the preview's report only in a conversation about the asset", async () => {
    const segments = draft.url.split("/").filter(Boolean);
    const token = segments[segments.indexOf(draft.fileSetId) + 1] ?? "";
    const created = z
      .object({ id: z.string() })
      .parse(
        (
          await t.expectOk(t.admin.id, "conversations.create", { payload: { title: "Look" } })
        ).json()
      );
    const conversationId = asConversationId(created.id);
    const report: PreviewReport = {
      settled: true,
      loaded: true,
      bridge: "connected",
      empty: false,
      entries: [],
      more: 0
    };
    const send = (userId: string) =>
      t.call(userId, "apps.sessions.report", {
        params: { pageSessionId: draft.pageSessionId },
        payload: { fileSetId: draft.fileSetId, token, report, conversationId }
      });
    expect((await send(t.admin.id)).json()).toEqual({ stored: false });
    await t.stores.conversations.setConversationSubject({
      clientInstanceId,
      conversationId,
      subject: { kind: KIND, name: "look" }
    });
    expect((await send(t.admin.id)).json()).toEqual({ stored: true });
    if (!isFileSetId(draft.fileSetId)) throw new Error("No file set id");
    const kept = await t.stores.pages.getPreviewReport({
      clientInstanceId,
      conversationId,
      fileSetId: draft.fileSetId,
      userId: asUserId(t.admin.id),
      notBefore: new Date(0).toISOString()
    });
    expect(kept?.report.bridge).toBe("connected");
    // The address was minted for the administrator: nobody else reports for it.
    expect((await send(t.lena.id)).statusCode).not.toBe(200);
  });

  it("is created by the agent in chat, and each save says the person sees it", async () => {
    const created = z
      .object({ id: z.string() })
      .parse(
        (
          await t.expectOk(t.admin.id, "conversations.create", { payload: { title: "Look" } })
        ).json()
      );
    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    const calls = createPlatformAssetCalls(options);
    const { admin } = t;
    const context: ToolExecutionContext = {
      user: {
        id: admin.id,
        externalUserId: admin.id,
        displayLabel: admin.displayLabel,
        roles: admin.roles,
        permissions: admin.permissions,
        permissionRefs: admin.permissionRefs,
        clientInstanceId,
        authSource: "test"
      },
      clientInstanceId,
      correlationId: `corr_${randomUUID()}`,
      toolRequest: {
        toolName: "platform.assets.put",
        toolCallId: asToolCallId(`call_${randomUUID()}`),
        agentRunId: asAgentRunId(`run_${randomUUID()}`),
        conversationId: asConversationId(created.id),
        agentName: "assistant",
        input: {}
      }
    };
    const first = await calls.put(context, { kind: KIND, name: "chat-look", files });
    expect(first).toMatchObject({ saved: true, created: true, kind: KIND, preview: true });
    const second = await calls.put(context, {
      expectedRevision: first.saved ? first.revision : 0,
      files
    });
    expect(second).toMatchObject({
      saved: true,
      kind: KIND,
      name: "chat-look",
      title: "Sample </script><b>",
      preview: true
    });
  });
});
