import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "@work-shape/catalyst-cli";
import { content, hash, useSkillCliWorlds } from "./support/skill-config-cli";

describe("CLI skill folder bytes", () => {
  const { fixture } = useSkillCliWorlds();
  it("validates and round-trips every file and records its hash", async () => {
    const f = await fixture(),
      source = await f.copy(),
      target = await f.copy(false);
    const pushed = await f.run(source, "push");
    expect(pushed, pushed.err).toMatchObject({ code: 0 });
    expect(f.calls.filter((call) => call.operation === "assets.put")).toHaveLength(1);
    expect(await f.run(target, "pull", { only: ["skill:form"] })).toMatchObject({ code: 0 });
    expect(
      f.calls.some(
        (call) => call.operation === "assets.get" && call.url.searchParams.get("files") === "true"
      )
    ).toBe(true);
    for (const [path, bytes] of Object.entries(content))
      expect(hash(await readFile(join(target, "skills/form", path)))).toBe(hash(bytes));
    const state = JSON.parse(await readFile(join(target, ".catalyst-state.json"), "utf8"));
    expect(state.instances.local.assets["skill:form"].files).toEqual(
      Object.fromEntries(Object.entries(content).map(([path, bytes]) => [path, hash(bytes)]))
    );
  });

  it("validates a byte skill with files", async () => {
    const f = await fixture(),
      source = await f.copy();
    expect(await f.run(source, "validate")).toMatchObject({ code: 0 });
    expect(f.calls.find((call) => call.operation === "assets.validate")?.body.files).toHaveLength(
      5
    );
  });

  it("diffs a binary change by hash and writes one whole folder", async () => {
    const f = await fixture(),
      source = await f.copy();
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    await writeFile(join(source, "skills/form/assets/logo.png"), Buffer.from([0, 1, 2]));
    expect(await f.run(source, "diff")).toMatchObject({
      code: 1,
      out: expect.stringContaining("binary, 6 B → 3 B")
    });
    f.calls.length = 0;
    expect(await f.run(source, "push", { only: ["skill:form"] })).toMatchObject({ code: 0 });
    expect(f.calls.filter((call) => call.operation === "assets.put")).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === "assets.sync")).toHaveLength(0);
    await rm(join(source, "skills/form/assets/logo.png"));
    expect(await f.run(source, "diff")).toMatchObject({
      code: 1,
      out: expect.stringContaining("binary, 3 B → 0 B")
    });
  });

  it("batches resource-only edits and shows UTF-8 script diffs", async () => {
    const f = await fixture(),
      target = await f.copy();
    expect(await f.run(target, "push")).toMatchObject({ code: 0 });
    await writeFile(join(target, "skills/form/references/r.md"), "# Changed reference\n");
    f.calls.length = 0;
    expect(await f.run(target, "push")).toMatchObject({ code: 0 });
    expect(f.calls.filter((call) => call.operation === "assets.put")).toHaveLength(0);
    expect(f.calls.filter((call) => call.operation === "assets.sync")).toHaveLength(1);
    await writeFile(join(target, "skills/form/scripts/fill_form.py"), "print('changed')\n");
    expect(await f.run(target, "diff")).toMatchObject({
      code: 1,
      out: expect.stringContaining("+print('changed')")
    });
  });

  it("reports a stale folder's conflict and scoped pull without overwriting local bytes", async () => {
    const f = await fixture(),
      source = await f.copy(),
      target = await f.copy(false);
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    expect(await f.run(target, "pull")).toMatchObject({ code: 0 });
    await writeFile(join(source, "skills/form/assets/logo.png"), Buffer.from([0, 9]));
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    const mine = Buffer.from([0, 8]);
    await writeFile(join(target, "skills/form/assets/logo.png"), mine);
    f.calls.length = 0;
    expect(await f.run(target, "push")).toMatchObject({
      code: 1,
      err: expect.stringContaining("catalyst config pull --only skill:form")
    });
    expect(
      f.calls.filter((call) => ["assets.put", "assets.sync"].includes(call.operation))
    ).toHaveLength(0);
    expect(await readFile(join(target, "skills/form/assets/logo.png"))).toEqual(mine);
  });

  it("skill put --from writes revision one with all five files and excludes state", async () => {
    const f = await fixture(),
      source = await f.copy();
    for (const name of [".catalyst-state.json", ".catalyst-skill.json"])
      await writeFile(join(source, "skills/form", name), "{}");
    const out: string[] = [],
      err: string[] = [];
    const code = await runCli(
      [
        "skill",
        "put",
        "form",
        "--from",
        "skills/form",
        "--if-revision",
        "new",
        "--instance",
        "https://catalyst.test",
        "--workspace",
        f.workspaceId
      ],
      {
        cwd: source,
        env: { CATALYST_API_KEY: "test" },
        fetchImpl: f.fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );
    expect({ code, err: err.join("") }).toMatchObject({ code: 0 });
    expect(out.join("")).toContain("revision 1");
    expect(f.calls.find((call) => call.operation === "assets.put")?.body.files).toHaveLength(5);
    expect(await f.run(source, "pull")).toMatchObject({ code: 0 });
    for (const [path, bytes] of Object.entries(content))
      expect(await readFile(join(source, "skills/form", path))).toEqual(bytes);
  });

  it("validates folder bytes on the server without creating an asset", async () => {
    const f = await fixture();
    const response = await f.world.api.call("assets.validate", {
      params: { kind: "skill" },
      payload: {
        config: { name: "form" },
        files: [
          { path: "SKILL.md", text: content["SKILL.md"].toString("utf8") },
          {
            path: "assets/bad.bin",
            base64: Buffer.from([0x7f, 0x45, 0x4c, 0x46]).toString("base64")
          }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      valid: false,
      issues: [{ path: ["assets/bad.bin"], code: "skill_file_executable" }]
    });
    const missing = await f.world.api.call("assets.get", {
      params: { kind: "skill", name: "form" },
      query: { workspaceId: f.workspaceId }
    });
    expect(missing.statusCode).toBe(404);
  });
});
