import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import type { JsonObject } from "@work-shape/catalyst-core";
import { createTestConfig } from "./fixtures";
import { createTestInstance, getTestExecution, type TestInstance } from "./test-instance";

// What the tests of a skill as a folder of files share: one skill's folder, an assembled
// instance with or without a store of files, and the calls that write and read the skill.

export const SKILL = { kind: "skill", name: "form-filler" } as const;

export const SKILL_MD = `---
title: Form filler
description: Use when a customer form has to be filled from a case.
---

# Form filler

Run \`scripts/fill_form.py\` on the case and attach \`assets/form.pdf\`.
`;
export const SCRIPT = "#!/usr/bin/env python3\nimport sys\n\nprint('filled', sys.argv[1:])\n";
export const GUIDE = "# Guide\n\nWhich field takes which value.\n";
/** A small PDF as a program writes one: its second line holds bytes that are no text. */
export const PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n%", "latin1"),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  Buffer.from(
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1"
  )
]);

const fileSchema = z.object({
  path: z.string(),
  contentType: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  text: z.string().optional(),
  base64: z.string().optional()
});
const readSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  revision: z.number(),
  files: z.array(fileSchema).optional()
});
const refusedSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

/** One file of a skill as a read with its files answers it. */
export type SkillFileRead = z.infer<typeof fileSchema>;

/** An assembled instance and its call path on one database. */
export interface SkillWorld {
  api: TestInstance;
  execution: ReturnType<typeof getTestExecution>;
}

type Address = { kind: string; name: string };

/** Starts instances for the tests of one file and closes them after each. */
export function useSkillWorlds(): {
  /** An instance with or without a store of files, and with or without changes by an agent. */
  start(files?: boolean, agentSkillChanges?: boolean): Promise<SkillWorld>;
  /** Only the API, for CLI tests that never execute an agent tool. */
  startApi(files?: boolean): Promise<TestInstance>;
} {
  const roots: string[] = [];
  const started: TestInstance[] = [];

  afterEach(async () => {
    await Promise.all(started.splice(0).map((instance) => instance.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const assemble = async (files: boolean, agentSkillChanges: boolean) => {
    const root = await mkdtemp(join(tmpdir(), "skill-folders-test-"));
    roots.push(root);
    const base = createTestConfig({
      tools: [
        { name: "read_skill", enabled: true },
        ...(agentSkillChanges ? [{ name: "propose_skill_change", enabled: true }] : [])
      ]
    });
    const config = parseClientInstanceConfig({
      ...base,
      modules: { assetManagement: { enabled: true } },
      administration: {
        agentConfiguration: {
          enabled: true,
          allowSkillEditing: true,
          ...(agentSkillChanges
            ? { agentSkillChanges: { enabled: true, allowSkillCreation: false } }
            : {})
        }
      },
      ...(files
        ? {
            infrastructure: {
              ...base.infrastructure,
              objectStorage: {
                ...base.infrastructure.objectStorage,
                files: { provider: "filesystem", root }
              }
            }
          }
        : {})
    });
    const api = await createTestInstance({ config, env: {}, tools: [] });
    started.push(api);
    return { api, config };
  };
  return {
    async startApi(files = true) {
      return (await assemble(files, false)).api;
    },
    async start(files = true, agentSkillChanges = false) {
      const { api, config } = await assemble(files, agentSkillChanges);
      const calls = await createTestInstance({ execution: { config, env: {}, tools: [] } });
      started.push(calls);
      return { api, execution: getTestExecution(calls) };
    }
  };
}

/**
 * Writes a skill and, where the write was its shared draft, publishes that draft: these tests
 * read the folder live (SKILL-DRAFT-1). The answer is the put's own.
 */
export const put = async (
  world: SkillWorld | Pick<SkillWorld, "api">,
  payload: JsonObject,
  address: Address = SKILL
): ReturnType<TestInstance["call"]> => {
  const written = await world.api.call("assets.put", { params: address, payload });
  await publishDraftOf(world, written, address, payload.workspaceId);
  return written;
};

/** Publishes the draft revision a write answered, if it answered one. */
export async function publishDraftOf(
  { api }: Pick<SkillWorld, "api">,
  written: Awaited<ReturnType<TestInstance["call"]>>,
  address: Address = SKILL,
  workspaceId?: unknown
): Promise<void> {
  if (written.statusCode !== 200) return;
  const { draftRevision } = z
    .object({ draftRevision: z.number().optional() })
    .loose()
    .parse(written.json());
  if (draftRevision === undefined) return;
  const published = await api.call("assets.publish", {
    params: address,
    payload: {
      revision: draftRevision,
      ...(typeof workspaceId === "string" ? { workspaceId } : {})
    }
  });
  expect(published.statusCode, published.body).toBe(200);
}

export async function get(
  { api }: SkillWorld,
  files = true,
  address: Address = SKILL
): Promise<z.infer<typeof readSchema>> {
  const response = await api.call("assets.get", {
    params: address,
    ...(files ? { query: { files: "true" } } : {})
  });
  expect(response.statusCode, response.body).toBe(200);
  return readSchema.parse(response.json());
}

/** What a refused write answers: 422 with a code, a message and its details. */
export async function refusal(
  response: ReturnType<TestInstance["call"]>
): Promise<z.infer<typeof refusedSchema>["error"]> {
  const answered = await response;
  expect(answered.statusCode, answered.body).toBe(422);
  return refusedSchema.parse(answered.json()).error;
}
