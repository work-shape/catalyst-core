import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isAppError } from "@work-shape/catalyst-core";
import {
  clientInstanceConfigSchema,
  parseClientInstanceConfig,
  workflowsConfigSchema
} from "@work-shape/catalyst-config-schema";
import {
  assertSandboxMemoryFitsHost,
  sandboxMemoryNeeded,
  sandboxMemoryTerms
} from "@work-shape/catalyst-client-assembly";

// The check a command worker makes before it starts: the sandboxes that can run at once must
// fit the memory of its host. Each kind of sandbox is one term, slots times memory.

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

const config = (fields: {
  sandbox?: Record<string, unknown>;
  commandSlots?: number;
  codeSteps?: Record<string, unknown>;
  stepSlots?: number;
}) =>
  clientInstanceConfigSchema.parse({
    clientInstance: { id: "demo", displayName: "Demo" },
    infrastructure: {
      models: { main: { provider: "deterministic" } },
      sandbox: fields.sandbox ?? { provider: "docker", image: "runner:test" }
    },
    executionWorkspaces: {
      enabled: true,
      ...(fields.commandSlots === undefined ? {} : { worker: { concurrency: fields.commandSlots } })
    },
    workflows: {
      ...(fields.codeSteps ? { codeSteps: fields.codeSteps } : {}),
      ...(fields.stepSlots === undefined ? {} : { stepSlots: fields.stepSlots })
    }
  });

const modules = (...on: string[]) => ({ isEnabled: (name: string) => on.includes(name) });

function check(input: {
  fields?: Parameters<typeof config>[0];
  on?: string[];
  host: number;
  pageBuilds?: string;
}) {
  const warnings: string[] = [];
  try {
    assertSandboxMemoryFitsHost({
      config: config(input.fields ?? {}),
      modules: modules(...(input.on ?? [])),
      env: { PAGE_BUILD_CONCURRENCY: input.pageBuilds },
      hostMemoryBytes: input.host,
      logger: { warn: (_fields: unknown, message?: string) => warnings.push(message ?? "") }
    });
    return { started: true as const, warnings };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      started: false as const,
      code: error.code,
      message: error.message,
      details: z
        .object({
          reason: z.string(),
          neededBytes: z.number(),
          hostBytes: z.number(),
          terms: z.array(z.object({ kind: z.string(), slots: z.number(), memoryBytes: z.number() }))
        })
        .parse(error.details)
    };
  }
}

describe("the defaults of a code step's sandbox", () => {
  it("are 512 MiB, half a core, 64 processes, 60 seconds, four at once and 2 GiB of disk", () => {
    expect(config({}).workflows.codeSteps).toEqual({
      slots: 4,
      memoryBytes: 512 * MIB,
      cpuCount: 0.5,
      pidsLimit: 64,
      timeoutSeconds: 60,
      scratchBytes: 64 * MIB,
      // The output directory is the worker's disk and no memory: no term of the memory check.
      diskBytes: 2048 * MIB
    });
  });

  it("count the working directory as part of the memory, and refuse one the memory cannot hold", () => {
    // The directory is memory of the container: it is inside `memoryBytes`, so the startup
    // check has no term for it, and it may take half of that memory at most.
    expect(
      config({ codeSteps: { scratchBytes: 256 * MIB } }).workflows.codeSteps.scratchBytes
    ).toBe(256 * MIB);
    expect(() => config({ codeSteps: { scratchBytes: 257 * MIB } })).toThrow(/scratchBytes/u);
    expect(() => config({ codeSteps: { memoryBytes: 64 * MIB } })).toThrow(/scratchBytes/u);
    expect(() => config({ codeSteps: { scratchBytes: MIB } })).toThrow();
    const terms = sandboxMemoryTerms({
      config: config({ codeSteps: { scratchBytes: 128 * MIB } }),
      modules: modules("workflows"),
      env: {}
    });
    expect(sandboxMemoryNeeded(terms)).toBe(4 * GIB + 4 * 512 * MIB);
  });

  it("are raised per release, and refused where they make no sandbox", () => {
    expect(config({ codeSteps: { memoryBytes: 2 * GIB } }).workflows.codeSteps.memoryBytes).toBe(
      2 * GIB
    );
    expect(() => config({ codeSteps: { memoryBytes: 1024 } })).toThrow();
    expect(() => config({ codeSteps: { slots: 0 } })).toThrow();
    expect(() => config({ codeSteps: { timeoutSeconds: 3600 } })).toThrow();
    expect(() => config({ codeSteps: { memory: 1 } })).toThrow();
  });
});

describe("the memory the sandboxes of a config can need at once", () => {
  const terms = (fields: Parameters<typeof config>[0], on: string[], pageBuilds?: string) =>
    sandboxMemoryTerms({
      config: config(fields),
      modules: modules(...on),
      env: { PAGE_BUILD_CONCURRENCY: pageBuilds }
    });

  it("counts the workspace commands: their slots times the sandbox's memory", () => {
    expect(terms({}, [])).toEqual([
      expect.objectContaining({ kind: "workspace commands", slots: 1, memoryBytes: 4 * GIB })
    ]);
    const three = terms(
      { commandSlots: 3, sandbox: { provider: "docker", image: "x", memoryBytes: 2 * GIB } },
      []
    );
    expect(three).toEqual([expect.objectContaining({ slots: 3, memoryBytes: 2 * GIB })]);
    expect(sandboxMemoryNeeded(three)).toBe(6 * GIB);
  });

  it("counts the Page builds where the module apps is on: their slots times the same memory", () => {
    expect(terms({}, ["apps"])).toContainEqual(
      expect.objectContaining({ kind: "page builds", slots: 2, memoryBytes: 4 * GIB })
    );
    expect(terms({}, ["apps"], "5")).toContainEqual(
      expect.objectContaining({ kind: "page builds", slots: 5 })
    );
    expect(terms({}, []).map((term) => term.kind)).not.toContain("page builds");
  });

  it("uses stepSlots for the sandbox reservation, with an explicit lower code cap", () => {
    expect(terms({ stepSlots: 2, codeSteps: { slots: 8 } }, ["workflows"])).toContainEqual(
      expect.objectContaining({ kind: "code steps", slots: 2 })
    );
    expect(terms({ stepSlots: 8 }, ["workflows"])).toContainEqual(
      expect.objectContaining({ kind: "code steps", slots: 8 })
    );
    expect(terms({ stepSlots: 8, codeSteps: { slots: 2 } }, ["workflows"])).toContainEqual(
      expect.objectContaining({ kind: "code steps", slots: 2 })
    );
  });

  it("counts the code steps where the module workflows is on: their slots times their own memory", () => {
    expect(terms({}, ["workflows"])).toContainEqual(
      expect.objectContaining({ kind: "code steps", slots: 4, memoryBytes: 512 * MIB })
    );
    expect(
      terms({ stepSlots: 8, codeSteps: { slots: 8, memoryBytes: GIB } }, ["workflows"])
    ).toContainEqual(expect.objectContaining({ kind: "code steps", slots: 8, memoryBytes: GIB }));
    expect(terms({}, []).map((term) => term.kind)).not.toContain("code steps");
    // All three together: 1 x 4 GiB, 2 x 4 GiB and 4 x 512 MiB.
    expect(sandboxMemoryNeeded(terms({}, ["apps", "workflows"]))).toBe(14 * GIB);
  });

  it("counts nothing for a sandbox that runs commands as processes of the worker", () => {
    expect(terms({ sandbox: { provider: "local" } }, ["apps", "workflows"])).toEqual([]);
  });
});

describe("a command worker that starts", () => {
  it("starts where the host holds every sandbox at once, to the byte", () => {
    expect(check({ on: ["workflows"], host: 6 * GIB })).toMatchObject({ started: true });
    expect(check({ on: ["workflows"], host: 6 * GIB - 1 })).toMatchObject({ started: false });
  });

  it("refuses with sandbox_memory_exceeds_host and names each term and its settings", () => {
    // The first operated instance: 16 GB, three command sandboxes of 4 GiB, Pages and Workflows.
    const refused = check({
      fields: { commandSlots: 3 },
      on: ["apps", "workflows"],
      host: 16 * GIB
    });
    expect(refused).toMatchObject({
      started: false,
      code: "VALIDATION_FAILED",
      details: {
        reason: "sandbox_memory_exceeds_host",
        neededBytes: 22 * GIB,
        hostBytes: 16 * GIB,
        terms: [
          { kind: "workspace commands", slots: 3, memoryBytes: 4 * GIB },
          { kind: "page builds", slots: 2, memoryBytes: 4 * GIB },
          { kind: "code steps", slots: 4, memoryBytes: 512 * MIB }
        ]
      }
    });
    const message = refused.started ? "" : refused.message;
    expect(message).toContain("need 22.00 GiB of memory, and this host has 16.00 GiB");
    expect(message).toContain(
      "workspace commands: 3 x 4.00 GiB = 12.00 GiB (executionWorkspaces.worker.concurrency x infrastructure.sandbox.memoryBytes)"
    );
    expect(message).toContain(
      "page builds: 2 x 4.00 GiB = 8.00 GiB (PAGE_BUILD_CONCURRENCY x infrastructure.sandbox.memoryBytes)"
    );
    expect(message).toContain(
      "code steps: 4 x 0.50 GiB = 2.00 GiB (min(workflows.stepSlots, workflows.codeSteps.slots) x workflows.codeSteps.memoryBytes)"
    );
  });

  it("is refused for each term alone that does not fit, and starts once that term is lowered", () => {
    // An instance of 8 GB.
    const host = 8 * GIB;
    expect(check({ fields: { commandSlots: 3 }, host })).toMatchObject({ started: false });
    expect(check({ fields: { commandSlots: 2 }, host })).toMatchObject({ started: true });
    expect(check({ on: ["apps"], host })).toMatchObject({ started: false });
    expect(check({ on: ["apps"], pageBuilds: "1", host })).toMatchObject({ started: true });
    const codeSteps = { slots: 16 };
    expect(check({ fields: { codeSteps, stepSlots: 16 }, on: ["workflows"], host })).toMatchObject({
      started: false
    });
    expect(
      check({ fields: { stepSlots: 8, codeSteps: { slots: 8 } }, on: ["workflows"], host })
    ).toMatchObject({
      started: true
    });
    expect(
      check({
        fields: { sandbox: { provider: "docker", image: "x", memoryBytes: GIB } },
        on: ["apps", "workflows"],
        host
      })
    ).toMatchObject({ started: true });
  });

  it("warns and starts where the sandbox is on another host, whose memory it cannot read", () => {
    const remote = check({
      fields: {
        commandSlots: 3,
        sandbox: { provider: "docker", image: "x", endpoint: "tcp://sandbox.internal:2376" }
      },
      on: ["apps", "workflows"],
      host: GIB
    });
    expect(remote.started).toBe(true);
    expect(remote.started ? remote.warnings : []).toEqual([
      expect.stringContaining("on another host, whose memory this process cannot read")
    ]);
    expect(remote.started ? remote.warnings[0] : "").toContain("22.00 GiB");
    // A host that holds its sandboxes starts without a word.
    expect(check({ host: 64 * GIB })).toEqual({ started: true, warnings: [] });
  });
});

describe("Workflow step slots at startup", () => {
  it("defaults to 4 and uses the configured count for code slots unless capped", () => {
    expect(workflowsConfigSchema.parse({}).stepSlots).toBe(4);
    expect(workflowsConfigSchema.parse({ stepSlots: 8 })).toMatchObject({
      stepSlots: 8,
      codeSteps: { slots: 8 }
    });
    expect(
      workflowsConfigSchema.parse({ stepSlots: 8, codeSteps: { slots: 2 } }).codeSteps.slots
    ).toBe(2);
  });
  it.each([1, 64])("accepts the boundary %s", (stepSlots) => {
    expect(workflowsConfigSchema.parse({ stepSlots }).stepSlots).toBe(stepSlots);
  });
  it.each([0, 65, -1, 1.5, "8", null, Infinity])(
    "refuses %s at startup with the setting named",
    (stepSlots) => {
      try {
        parseClientInstanceConfig({ ...config({}), workflows: { stepSlots } });
        throw new Error("The invalid setting was accepted");
      } catch (error) {
        expect(error).toMatchObject({
          code: "VALIDATION_FAILED",
          details: {
            issues: expect.arrayContaining([
              expect.objectContaining({ path: ["workflows", "stepSlots"] })
            ])
          }
        });
      }
    }
  );
});
