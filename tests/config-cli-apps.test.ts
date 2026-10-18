import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Asset } from "@work-shape/catalyst-api-contract";
import type { PageBuildRunner } from "@work-shape/catalyst-server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { publishReview, runCli } from "@work-shape/catalyst-cli";
import { setupAppInstance } from "./support/app-instance";
import { testOperations } from "./support/operations";
import { fileRoute, reactManifest, rootRoute } from "./support/page-build";
import { createTestFetch, type TestInstance } from "./support/test-instance";

// `catalyst app pull|push|publish|status` against an instance: an App as a folder, sent and
// read through the asset operations with the rights of the person whose key the CLI holds.

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "catalyst-app-cli-"));
  directories.push(directory);
  return directory;
}

/** The CLI as one user of the instance. The key exchange is answered here. */
function cliAs(
  instance: TestInstance,
  userId: string,
  cwd: string,
  prompt?: (question: string) => Promise<string>,
  /** Signs in through the user's personal key, as the CLI does, instead of their session. */
  personalKey = false
) {
  const serverFetch = createTestFetch(instance, {
    "x-test-user": userId,
    ...(personalKey ? { "x-test-key": "personal" } : {})
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === testOperations["access_tokens.exchange"].path) {
      return new Response(
        JSON.stringify({
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return serverFetch(request);
  };
  return async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...args, "--instance", "https://catalyst.test"], {
      cwd,
      env: { CATALYST_API_KEY: "cat_personal" },
      fetchImpl,
      ...(prompt === undefined ? {} : { prompt }),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text)
    });
    return { code, out: out.join(""), err: err.join("") };
  };
}

/**
 * A build that hands the manifest on as it was written, every key kept, and the other files
 * as built. What a real build does is the subject of the build's own tests.
 */
const passThroughBuild: PageBuildRunner = async ({ files }) => {
  const manifestFile = files.find((file) => file.path === "app.yaml");
  const manifest = testManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(manifestFile?.bytes))
  );
  return {
    status: "built",
    manifest,
    kitVersion: manifest.kit,
    files: files.filter((file) => file.path !== "app.yaml")
  };
};

const testManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  kit: z.string(),
  entry: z.string(),
  externalHosts: z.array(z.string()).optional()
});

const manifest = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ id: "offers", name: "Offers", kit: "1.0.0", entry: "index.html", ...extra })}\n`;

/** Every file below a folder, by its path inside it, as bytes. */
async function filesOf(directory: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.set(relative(directory, path).split(sep).join("/"), await readFile(path));
    }
  };
  await walk(directory);
  return found;
}

async function writeFolder(directory: string, files: Record<string, string | Buffer>) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
}

describe("catalyst app commands", () => {
  it("pulls and pushes an App's folder byte for byte, leaving out what is not the App's", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: passThroughBuild });
    try {
      const cwd = await temporaryDirectory();
      const run = cliAs(t.instance, t.admin.id, cwd);
      const sent = {
        "app.yaml": manifest(),
        "index.html": "<!doctype html>\r\n<title>Offers</title>\r\n<p>Größe</p>\r\n",
        "src/notes.txt": "﻿starts with a byte order mark\n",
        "assets/pixel.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a]),
        "assets/empty.txt": ""
      };
      await writeFolder(join(cwd, "offers"), {
        ...sent,
        ".DS_Store": "finder",
        ".env": "SECRET=never-sent",
        "node_modules/left/index.js": "out",
        ".cache/build.json": "{}"
      });

      const created = await run("app", "push", "offers", "--workspace", t.workspaceId);
      expect(created, created.err).toMatchObject({ code: 0 });
      expect(created.out).toContain("Created App 'offers' at draft revision 1 (5 files, built).");
      expect(created.out).toContain("Left out: .DS_Store, .cache/, .env, node_modules/");

      // The folder of the pull holds what was sent and the state; the state names the
      // workspace, so the next commands need no flag.
      const pulled = await run("app", "pull", "offers", "copy");
      expect(pulled, pulled.err).toMatchObject({ code: 2 });
      expect(pulled.err).toContain("Name the workspace");
      const pulledAgain = await run("app", "pull", "offers", "copy", "--workspace", t.workspaceId);
      expect(pulledAgain, pulledAgain.err).toMatchObject({ code: 0 });
      expect(pulledAgain.out).toContain("Pulled the draft 1 of App 'offers'");
      const copy = await filesOf(join(cwd, "copy"));
      expect(copy.has(".catalyst-app.json")).toBe(true);
      copy.delete(".catalyst-app.json");
      expect(Object.fromEntries(copy)).toEqual(
        Object.fromEntries(
          Object.entries(sent).map(([path, contents]) => [path, Buffer.from(contents)])
        )
      );

      // Pushed back unchanged and pulled once more, every byte is the same.
      const pushedBack = await run("app", "push", "copy");
      expect(pushedBack, pushedBack.err).toMatchObject({ code: 0 });
      expect(pushedBack.out).toContain("Pushed App 'offers' at draft revision 2");
      const second = await run("app", "pull", "offers", "second", "--workspace", t.workspaceId);
      expect(second, second.err).toMatchObject({ code: 0 });
      const secondFiles = await filesOf(join(cwd, "second"));
      secondFiles.delete(".catalyst-app.json");
      expect(Object.fromEntries(secondFiles)).toEqual(
        Object.fromEntries(
          Object.entries(sent).map(([path, contents]) => [path, Buffer.from(contents)])
        )
      );

      // A pull does not overwrite a local edit, and status names it.
      await writeFile(join(cwd, "second", "index.html"), "<p>edited</p>");
      const overwrite = await run("app", "pull", "offers", "second");
      expect(overwrite).toMatchObject({ code: 2 });
      expect(overwrite.err).toContain("- index.html");
      const status = await run("app", "status", "offers", "second");
      expect(status, status.err).toMatchObject({ code: 0 });
      expect(status.out).toContain("Draft:     revision 2");
      expect(status.out).toContain("Published: not published yet");
      expect(status.out).toContain("Build:     draft revision 2 built with kit 1.0.0");
      expect(status.out).toContain("changed  index.html");
    } finally {
      await t.close();
    }
  });

  it("refuses a push made against a draft that moved since the pull, and writes nothing", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: passThroughBuild });
    try {
      const cwd = await temporaryDirectory();
      const run = cliAs(t.instance, t.admin.id, cwd);
      await writeFolder(join(cwd, "offers"), { "app.yaml": manifest(), "index.html": "<p>1</p>" });
      expect((await run("app", "push", "offers", "--workspace", t.workspaceId)).code).toBe(0);
      expect((await run("app", "pull", "offers", "late", "--workspace", t.workspaceId)).code).toBe(
        0
      );
      await writeFile(join(cwd, "offers", "index.html"), "<p>2</p>");
      expect((await run("app", "push", "offers")).code).toBe(0);

      await writeFile(join(cwd, "late", "index.html"), "<p>late</p>");
      const stale = await run("app", "push", "late");
      expect(stale.code).toBe(1);
      expect(stale.err).toContain(
        "The draft moved since revision 1 was pulled. Nothing was written."
      );
      expect(await t.listed("offers")).toMatchObject({ revision: 2 });
    } finally {
      await t.close();
    }
  });

  it("pushes a file deleted in the folder as deleted and refuses an app.yaml that names another id", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: passThroughBuild });
    try {
      const cwd = await temporaryDirectory();
      const run = cliAs(t.instance, t.admin.id, cwd);
      await writeFolder(join(cwd, "offers"), {
        "app.yaml": manifest(),
        "index.html": "<p>1</p>",
        "old.txt": "gone after the next push"
      });
      expect((await run("app", "push", "offers", "--workspace", t.workspaceId)).code).toBe(0);

      await rm(join(cwd, "offers", "old.txt"));
      expect((await run("app", "push", "offers")).code).toBe(0);
      expect((await run("app", "pull", "offers", "check", "--workspace", t.workspaceId)).code).toBe(
        0
      );
      expect([...(await filesOf(join(cwd, "check"))).keys()].sort()).toEqual([
        ".catalyst-app.json",
        "app.yaml",
        "index.html"
      ]);

      await writeFile(join(cwd, "check", "app.yaml"), manifest({ id: "other" }));
      const renamed = await run("app", "push", "check");
      expect(renamed.code).toBe(2);
      expect(renamed.err).toContain("app.yaml names the id 'other'");
      expect(await t.listed("offers")).toMatchObject({ revision: 2 });

      // A folder never pulled that names the id of an App there is told how to go on.
      await writeFolder(join(cwd, "fresh"), { "app.yaml": manifest(), "index.html": "<p>x</p>" });
      const taken = await run("app", "push", "fresh", "--workspace", t.workspaceId);
      expect(taken.code).toBe(1);
      expect(taken.err).toContain("An App named 'offers' exists already.");
      expect(await t.listed("offers")).toMatchObject({ revision: 2 });
    } finally {
      await t.close();
    }
  });

  it("shows what a publish makes live, keeps the terminal question, and sends --yes to the Inbox", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: passThroughBuild });
    try {
      const cwd = await temporaryDirectory();
      const run = cliAs(t.instance, t.admin.id, cwd);
      await writeFolder(join(cwd, "offers"), { "app.yaml": manifest(), "index.html": "<p>1</p>" });
      expect((await run("app", "push", "offers", "--workspace", t.workspaceId)).code).toBe(0);
      const scripted = await cliAs(t.instance, t.admin.id, cwd, async () => "y", true)(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--workspace",
        t.workspaceId,
        "--yes"
      );
      // `--yes` asks nothing and publishes nothing: the publish waits in the admin's own Inbox.
      expect(scripted.code).toBe(3);
      expect(scripted.err).toMatch(
        /Waits in your Inbox for your confirmation; nothing has changed yet \(request \S+, Operation Run \S+\)/u
      );
      expect(await t.listed("offers")).not.toHaveProperty("publishedRevision");
      const first = await cliAs(t.instance, t.admin.id, cwd, async () => "y")(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--workspace",
        t.workspaceId
      );
      expect(first, first.err).toMatchObject({ code: 0 });
      expect(first.out).toContain("opens for");
      expect(first.out).not.toContain("Publish revision 1 of App 'offers' (its first publish).");
      expect(first.out).toContain("Published revision 1 of App 'offers'.");

      await writeFile(
        join(cwd, "offers", "app.yaml"),
        manifest({ externalHosts: ["api.example.org"] })
      );
      expect((await run("app", "push", "offers")).code).toBe(0);

      const asked = await run(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--workspace",
        t.workspaceId
      );
      expect(asked.code).toBe(1);
      expect(asked.out).not.toContain("Publish revision 2 of App 'offers' in place of revision 1.");
      expect(asked.out).not.toContain("External hosts it calls:\n  api.example.org  (added)");
      expect(asked.err).toContain("needs your answer here, so a run without a terminal");
      expect(await t.listed("offers")).toMatchObject({ publishedRevision: 1 });

      const questions: string[] = [];
      const declined = await cliAs(t.instance, t.admin.id, cwd, async (question) => {
        questions.push(question);
        return questions.length === 1 ? "d" : "n";
      })("app", "publish", "offers", "--audience", "workspace", "--workspace", t.workspaceId);
      expect(declined).toMatchObject({ code: 1, err: "Nothing was published.\n" });
      const publishQuestion =
        "Publish revision 2 of app 'offers'? If approval is required, this files a request in the Inbox. [y/N; d=Details] ";
      expect(questions).toEqual([publishQuestion, publishQuestion]);
      expect(declined.out).toContain("Publish revision 2 of App 'offers' in place of revision 1.");
      expect(declined.out).toContain("External hosts it calls:\n  api.example.org  (added)");
      expect(await t.listed("offers")).toMatchObject({ publishedRevision: 1 });

      const confirmed = await cliAs(t.instance, t.admin.id, cwd, async () => "y")(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--workspace",
        t.workspaceId,
        "--json"
      );
      expect(confirmed, confirmed.err).toMatchObject({ code: 0 });
      expect(JSON.parse(confirmed.out)).toMatchObject({
        publishedRevision: 2,
        replacedRevision: 1
      });
      expect(confirmed.err).not.toContain(
        "Publish revision 2 of App 'offers' in place of revision 1."
      );
      expect(await t.listed("offers")).toMatchObject({ publishedRevision: 2 });

      const status = await run("app", "status", "offers", "--workspace", t.workspaceId);
      expect(status.out).toContain("Published: revision 2");
      expect(status.out).toContain("the draft is published");
    } finally {
      await t.close();
    }
  });

  it("refuses every App command to a workspace builder who may not write the App", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: passThroughBuild });
    try {
      // Kai holds agent and skill rights in the workspace. Those rights do not grant
      // access to Apps; workspace membership alone does not allow their drafts either.
      for (const action of ["agent.read", "agent.write", "skill.read", "skill.write"]) {
        await t.grant(t.kai.id, action, { workspaceId: t.workspaceId });
      }
      const cwd = await temporaryDirectory();
      await writeFolder(join(cwd, "offers"), { "app.yaml": manifest(), "index.html": "<p>1</p>" });
      const admin = cliAs(t.instance, t.admin.id, cwd);
      expect((await admin("app", "push", "offers", "--workspace", t.workspaceId)).code).toBe(0);

      const kai = cliAs(t.instance, t.kai.id, cwd);
      await writeFolder(join(cwd, "kai-offers"), {
        "app.yaml": manifest({ id: "kai-offers" }),
        "index.html": "<p>kai</p>"
      });
      const created = await kai("app", "push", "kai-offers", "--workspace", t.workspaceId);
      expect(created.code).toBe(1);
      expect(created.err).toContain("HTTP 403");
      expect(created.err).toContain("app.write");

      const pulled = await kai("app", "pull", "offers", "theirs", "--workspace", t.workspaceId);
      expect(pulled.code).toBe(1);
      expect(pulled.err).toContain("HTTP 403");

      const published = await kai(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--workspace",
        t.workspaceId,
        "--yes"
      );
      expect(published.code).toBe(1);
      expect(published.err).toContain("HTTP 403");
      expect(await t.listed("offers")).not.toHaveProperty("publishedRevision");
      expect(await t.listed("kai-offers").catch(() => undefined)).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it("prints each build error as file:line:column and exits 1 without writing", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: "sandbox" });
    try {
      const cwd = await temporaryDirectory();
      const run = cliAs(t.instance, t.admin.id, cwd);
      await writeFolder(join(cwd, "demo"), {
        "app.yaml": reactManifest,
        "src/routes/__root.tsx": rootRoute,
        "src/routes/index.tsx": fileRoute("/"),
        "src/routes/history.tsx": `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/history")({
  component: () => <p>History</p
});
`
      });

      const pushed = await run("app", "push", "demo", "--workspace", t.workspaceId);

      expect(pushed.code).toBe(1);
      expect(pushed.err).toContain("VALIDATION_FAILED");
      expect(pushed.err).toMatch(/^- src\/routes\/history\.tsx:4:\d+: /mu);
      expect(await filesOf(join(cwd, "demo"))).not.toContain(".catalyst-app.json");
      expect(await t.listed("demo").catch(() => undefined)).toBeUndefined();
    } finally {
      await t.close();
    }
  }, 120_000);

  it("refuses to push a file above the size of one file of an App before sending anything", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: passThroughBuild });
    try {
      const cwd = await temporaryDirectory();
      await writeFolder(join(cwd, "offers"), {
        "app.yaml": manifest(),
        "assets/video.bin": Buffer.alloc(2 * 1024 * 1024 + 1)
      });
      const pushed = await cliAs(t.instance, t.admin.id, cwd)(
        "app",
        "push",
        "offers",
        "--workspace",
        t.workspaceId
      );
      expect(pushed.code).toBe(1);
      expect(pushed.err).toContain("A file of an App holds at most 2.0 MiB.");
      expect(pushed.err).toContain("- assets/video.bin: 2.0 MiB");
    } finally {
      await t.close();
    }
  });
});

describe("SHARE-1 CLI audience", () => {
  it("check 80: asks For whom before the publish review and sends only the person's choice", async () => {
    const t = await setupAppInstance({ explicitCredentials: true, build: passThroughBuild });
    try {
      const cwd = await temporaryDirectory();
      await writeFolder(join(cwd, "offers"), { "app.yaml": manifest(), "index.html": "<p>1</p>" });
      expect(
        (
          await cliAs(t.instance, t.admin.id, cwd)(
            "app",
            "push",
            "offers",
            "--workspace",
            t.workspaceId
          )
        ).code
      ).toBe(0);
      const questions: string[] = [];
      const result = await cliAs(t.instance, t.admin.id, cwd, async (question) => {
        questions.push(question);
        return question.startsWith("For whom?") ? "self" : "y";
      })("app", "publish", "offers", "--audience", "workspace", "--workspace", t.workspaceId);
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(questions[0]).toContain("For whom?");
      expect(questions[0]).toContain("Sales");
      expect(questions[1]).toContain("Publish revision");
      expect(result.out).toContain("Only the builder");
      expect(
        (
          await t.stores.configAssets.getConfigAsset({
            clientInstanceId: t.admin.clientInstanceId,
            kind: "app",
            name: "offers"
          })
        )?.appAvailability?.audience
      ).toBe("self");
      const unattended = await cliAs(t.instance, t.admin.id, cwd)(
        "app",
        "publish",
        "offers",
        "--workspace",
        t.workspaceId,
        "--yes"
      );
      expect(unattended.code).toBe(2);
      expect(unattended.err).toContain("--audience self|workspace|instance");
    } finally {
      await t.close();
    }
  });
});

describe("the publish review of an App", () => {
  const app = (
    revision: number,
    manifestOf: Record<string, unknown>,
    published?: number
  ): Asset => ({
    id: "a1",
    kind: "app",
    name: "offers",
    scope: { kind: "workspace", workspaceId: "w1" },
    revision,
    contentRevision: revision,
    draftRevision: revision,
    ...(published === undefined ? {} : { publishedRevision: published }),
    config: { name: "offers", title: "Offers", manifest: manifestOf },
    updatedAt: "2026-10-13T00:00:00.000Z"
  });

  it("marks the changing actions new or changed and the hosts and stores added", () => {
    const live = app(1, {
      externalHosts: ["kept.example.org"],
      actions: [
        { name: "save_offer", kind: "sql", effect: "changing", sql: "insert 1" },
        { name: "send_offer", kind: "connection", effect: "changing", operation: "send" },
        { name: "list_offers", kind: "sql", effect: "reading" }
      ],
      dataStores: [{ name: "offers", minSchema: 2 }]
    });
    const draft = app(
      2,
      {
        connections: ["crm"],
        externalHosts: ["kept.example.org", "api.example.org"],
        actions: [
          { name: "save_offer", kind: "sql", effect: "changing", sql: "insert 2" },
          { effect: "changing", operation: "send", name: "send_offer", kind: "connection" },
          { name: "archive_offer", kind: "sql", effect: "changing" },
          { name: "list_offers", kind: "sql", effect: "reading", sql: "select 2" }
        ],
        dataStores: [{ name: "offers", minSchema: 3 }]
      },
      1
    );

    expect(publishReview(draft, live)).toEqual({
      revision: 2,
      publishedRevision: 1,
      connections: ["crm"],
      externalHosts: [
        { host: "kept.example.org", added: false },
        { host: "api.example.org", added: true }
      ],
      changingActions: [
        { name: "save_offer", change: "changed" },
        { name: "send_offer", change: "unchanged" },
        { name: "archive_offer", change: "new" }
      ],
      dataStores: [{ name: "offers", minSchema: 3, added: true }]
    });
  });
});
