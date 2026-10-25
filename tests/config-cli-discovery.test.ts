import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_VERSION,
  platformContextSchema,
  platformDocsSchema
} from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import { PLATFORM_DOCS_SKILL_NAME } from "@work-shape/catalyst-core";
import { seedShippedSkills } from "@work-shape/catalyst-server";
import {
  setupAccessInstance,
  recordAuthAdapter,
  SCOPES_HEADER,
  clientInstanceId,
  skill
} from "./support/access-instance";
import { createTestFetch } from "./support/test-instance";
import { testOperations } from "./support/operations";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

/** A synthetic key exchange followed by real authenticated routes; no socket or public host. */
async function computer(cliVersion?: string) {
  const t = await setupAccessInstance({
    server: () => ({ authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" } })
  });
  const cwd = await mkdtemp(join(tmpdir(), "adisc-1-"));
  const serverFetch = createTestFetch(t.instance, {
    "x-test-user": t.admin.id,
    "x-test-key": "personal",
    [SCOPES_HEADER]: "config_assets:read"
  });
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://instance.test");
    requests.push(url.pathname);
    if (url.pathname === testOperations["access_tokens.exchange"].path) {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-key");
      return Response.json({
        accessToken: "synthetic-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
    const response = await serverFetch(request);
    if (url.pathname === testOperations["platform.context.get"].path) {
      const context = platformContextSchema.parse(await response.json());
      context.release = {
        version: RELEASE_VERSION,
        ...(cliVersion === undefined ? {} : { cliVersion })
      };
      return Response.json(context);
    }
    return response;
  };
  return {
    t,
    requests,
    run: async (...args: string[]) => {
      const out: string[] = [],
        err: string[] = [];
      const code = await runCli([...args, "--instance", "https://instance.test"], {
        cwd,
        env: { CATALYST_API_KEY: "synthetic-key" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      });
      return { code, out: out.join(""), err: err.join("") };
    },
    close: async () => {
      await t.instance.close();
      await rm(cwd, { recursive: true, force: true });
    }
  };
}

describe("the local agent's first minute (ADISC-1)", () => {
  it("check 68: a key reads context, stored release docs and permitted skills; unknown help exits 2", async () => {
    const c = await computer();
    try {
      const markdown = "# CLI\n\nUse the CLI.\n\nStored release body.";
      await seedShippedSkills({
        clientInstanceId,
        stores: c.t.stores,
        skills: [
          {
            name: PLATFORM_DOCS_SKILL_NAME,
            title: "Docs",
            description: "Release docs",
            content: "Index",
            icon: "guide",
            resources: [
              { path: "references/configure/cli.md", mediaType: "text/markdown", content: markdown }
            ]
          }
        ]
      });
      await applyAtCurrentRevisions(c.t.stores.configAssets, {
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "skill", name: "permitted", config: skill("permitted") }
        ]
      });
      const context = await c.run("context", "--json");
      expect(context.code, context.err).toBe(0);
      expect(platformContextSchema.parse(JSON.parse(context.out))).toMatchObject({
        instance: { name: "Access test" },
        release: { version: RELEASE_VERSION }
      });
      const index = await c.run("docs", "--json");
      expect(index.code, index.err).toBe(0);
      expect(platformDocsSchema.parse(JSON.parse(index.out))).toMatchObject({
        pages: [{ path: "configure/cli", title: "CLI", description: "Use the CLI." }]
      });
      expect((await c.run("docs")).out).toContain("configure\n  configure/cli");
      expect(await c.run("docs", "configure/cli")).toEqual({ code: 0, out: markdown, err: "" });
      const page = await c.run("docs", "configure/cli", "--json");
      expect(platformDocsSchema.parse(JSON.parse(page.out))).toMatchObject({ markdown });
      expect((await c.run("skill", "list", "--json")).out).toContain("permitted");
      const unknown = await c.run("nosuchthing", "--help");
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain("Unknown command 'nosuchthing'");
      expect(unknown.err).toContain("Instance:");
      // The setup skill teaches `keys list` and `instance workspaces`; their help must answer.
      for (const noun of ["keys", "instance"]) {
        const help = await c.run(noun, "--help");
        expect(help.code).toBe(0);
        expect(help.out).toContain(`${noun} `);
      }
      expect((await c.run("data_store", "--help")).code).toBe(0);
    } finally {
      await c.close();
    }
  });

  // Newer than whatever this build is, so a cut to any version keeps the cases newer.
  const [major, minor, patch] = RELEASE_VERSION.split(/[.+-]/u).map(Number);
  it.each([
    `${major}.${minor}.${patch + 1}`,
    `${major}.${minor + 1}.0-rc.1`,
    `${major + 1}.0.0-beta.1`
  ])("check 73: %s prints an update on stderr, preserving JSON stdout", async (version) => {
    const c = await computer(version);
    try {
      for (const flags of [[], ["--json"]]) {
        const result = await c.run("context", ...flags);
        expect(result.code, result.err).toBe(0);
        expect(result.err).toBe(
          `This CLI is ${RELEASE_VERSION}; the instance names ${version}: npm install --global @work-shape/catalyst-cli@${version}\n`
        );
        if (flags.length)
          expect(platformContextSchema.parse(JSON.parse(result.out)).release.cliVersion).toBe(
            version
          );
      }
    } finally {
      await c.close();
    }
  });

  it.each([
    undefined,
    RELEASE_VERSION,
    `${RELEASE_VERSION}+build.1`,
    "0.8.0-rc.3",
    "0.7.99",
    "invalid"
  ])("check 73: %s adds no notice", async (version) => {
    const c = await computer(version);
    try {
      expect((await c.run("context", "--json")).err).toBe("");
    } finally {
      await c.close();
    }
  });

  it("keeps offline help for built-in kind nouns and a new kind's known verb", async () => {
    for (const argv of [
      ["skill", "--help"],
      ["skills", "--help"],
      ["custom-kind", "list", "--help"]
    ]) {
      expect(
        await runCli(argv, {
          env: {},
          fetchImpl: async () => {
            throw new Error("Offline");
          },
          stdout: () => undefined
        })
      ).toBe(0);
    }
  });
});
