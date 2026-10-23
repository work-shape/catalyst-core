import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { useSkillCliWorlds } from "./support/skill-config-cli";

describe("CLI skill folder write outcomes", () => {
  const { fixture } = useSkillCliWorlds();
  it.each(["approval", "refusal", "race"])(
    "reports a folder %s after recording the preceding sync",
    async (failure) => {
      const f = await fixture(),
        source = await f.copy();
      expect(await f.run(source, "push")).toMatchObject({ code: 0 });
      const statePath = join(source, ".catalyst-state.json");
      const before = JSON.parse(await readFile(statePath, "utf8"));
      await mkdir(join(source, "skills/notes"));
      await writeFile(
        join(source, "skills/notes/SKILL.md"),
        "---\nname: notes\ndescription: Notes.\n---\n\n# Notes\n"
      );
      const mine = Buffer.from([0, 8]);
      await writeFile(join(source, "skills/form/assets/logo.png"), mine);
      const fetchImpl: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "PUT") {
          if (failure === "approval")
            return Response.json(
              {
                id: "held-folder",
                operation: "assets.put",
                effect: "changing",
                status: "pending_approval",
                actor: { kind: "user", id: "user-1", label: "User" },
                origin: { kind: "cli" },
                target: "live",
                inputHash: "hash",
                attempt: 1,
                correlationId: "correlation",
                createdAt: "2026-10-23T00:00:00Z",
                href: apiOperations["operations.get_run"].buildPath({
                  params: { runId: "held-folder" }
                })
              },
              { status: 202 }
            );
          return Response.json(
            {
              error: {
                code: failure === "race" ? "REVISION_CONFLICT" : "VALIDATION_FAILED",
                message: "Folder refused",
                details: {
                  reason: "refused",
                  conflicts:
                    failure === "race" ? [{ kind: "skill", name: "form", currentRevision: 2 }] : []
                }
              }
            },
            { status: failure === "race" ? 409 : 422 }
          );
        }
        return f.fetchImpl(request);
      };
      const result = await f.run(source, "push", { fetchImpl });
      expect(result.code).toBe(1);
      expect(result.err).toContain("skill:form");
      expect(result.err).toContain("applied");
      if (failure === "approval") expect(result.err).toContain("held-folder");
      if (failure === "race")
        expect(result.err).toContain("catalyst config pull --only skill:form");
      const after = JSON.parse(await readFile(statePath, "utf8"));
      expect(after.instances.local.assets["skill:form"]).toEqual(
        before.instances.local.assets["skill:form"]
      );
      expect(after.instances.local.assets["skill:notes"].revision).toBe(1);
      expect(await readFile(join(source, "skills/form/assets/logo.png"))).toEqual(mine);
    }
  );
});
