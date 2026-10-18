import { describe, expect, it, vi } from "vitest";
import { platformDocsSchema, RELEASE_VERSION } from "@work-shape/catalyst-api-contract";
import {
  PLATFORM_DOCS_SKILL_NAME,
  asClientInstanceId,
  type ShippedSkill
} from "@work-shape/catalyst-core";
import { skillConfigSchema } from "@work-shape/catalyst-config-schema";
import { seedShippedSkills } from "@work-shape/catalyst-server";
import { createTestInstanceWith, createTestFetch } from "./support/test-instance";
import { testOperations } from "./support/operations";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

const docs = (text: string): ShippedSkill => ({
  name: PLATFORM_DOCS_SKILL_NAME,
  title: "Release docs",
  description: "Product docs",
  content: "Index",
  icon: "guide",
  resources: [
    {
      path: "references/configure/z.md",
      mediaType: "text/markdown",
      content: `# Z ${text}\n\nDescription ${text}\n\nBody ${text}\n`
    },
    {
      path: "references/getting-started/a.md",
      mediaType: "text/markdown",
      content: "# A\n\nStart here\n\nA body.\n"
    }
  ]
});

describe("release docs (ADISC-1 check 69)", () => {
  it("reads each of two instances' stored release skills, without a public request", async () => {
    const publicFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No public host"));
    try {
      for (const text of ["old release", "new release"]) {
        const clientInstanceId = asClientInstanceId(text.replaceAll(" ", "-"));
        const instance = await createTestInstanceWith(() => ({ clientInstanceId }));
        try {
          const skill = docs(text);
          await seedShippedSkills({ clientInstanceId, stores: instance.stores, skills: [skill] });
          const runs = vi.spyOn(instance.stores.operationRuns, "create");
          const audit = vi.spyOn(instance.stores.audit, "appendAuditEvent");
          const transport = vi.fn(createTestFetch(instance));
          const response = await transport(
            new Request(`https://instance.test${testOperations["platform.docs.get"].path}`)
          );
          expect(response.status).toBe(200);
          expect(platformDocsSchema.parse(await response.json())).toEqual({
            release: { version: RELEASE_VERSION },
            pages: [
              { path: "configure/z", title: `Z ${text}`, description: `Description ${text}` },
              { path: "getting-started/a", title: "A", description: "Start here" }
            ]
          });
          const read = await transport(
            new Request(
              `https://instance.test${testOperations["platform.docs.get"].path}?page=configure%2Fz`
            )
          );
          expect(platformDocsSchema.parse(await read.json())).toEqual({
            release: { version: RELEASE_VERSION },
            path: "configure/z",
            title: `Z ${text}`,
            markdown: skill.resources?.[0]?.content
          });
          expect(read.headers.get("operation-run-id")).toBeNull();
          expect(runs).not.toHaveBeenCalled();
          expect(audit).not.toHaveBeenCalled();
          runs.mockRestore();
          audit.mockRestore();
          for (const page of [
            "unknown",
            "../x",
            "/etc/passwd",
            "https://x",
            "x\\y",
            "configure/z.md"
          ]) {
            const refused = await instance.call("platform.docs.get", { query: { page } });
            expect(refused.statusCode, refused.body).toBe(404);
            expect(refused.json()).toMatchObject({
              error: { message: "Documentation page not found" }
            });
          }
          expect(
            transport.mock.calls.every(
              ([input]) =>
                new URL(String(input instanceof Request ? input.url : input)).host ===
                "instance.test"
            )
          ).toBe(true);
        } finally {
          await instance.close();
        }
      }
      expect(publicFetch).not.toHaveBeenCalled();
    } finally {
      publicFetch.mockRestore();
    }
  });

  it("answers the same not found for missing docs and a Studio copy named platform-docs", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const instance = await createTestInstanceWith(() => ({}));
    const missing = await instance.call("platform.docs.get");
    expect(missing.statusCode).toBe(404);
    await seedShippedSkills({
      clientInstanceId,
      stores: instance.stores,
      skills: [docs("Studio")]
    });
    const row = await instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: PLATFORM_DOCS_SKILL_NAME
    });
    const studioConfig = { ...row?.config };
    delete studioConfig.origin;
    expect(skillConfigSchema.safeParse(studioConfig).success).toBe(true);
    await applyAtCurrentRevisions(instance.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: PLATFORM_DOCS_SKILL_NAME,
          config: studioConfig
        }
      ]
    });
    const copied = await instance.call("platform.docs.get");
    expect(copied.statusCode, copied.body).toBe(404);
    expect(copied.json()).toMatchObject({ error: { message: "Documentation page not found" } });
    await instance.close();
  });
});
