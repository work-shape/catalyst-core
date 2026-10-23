import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect } from "vitest";
import { runConfigCommand } from "@work-shape/catalyst-cli";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTestFetch } from "./test-instance";
import { useSkillWorlds, PDF } from "./skill-folders";

export const content = {
  "SKILL.md": Buffer.from("---\nname: form\ndescription: Fill forms.\n---\n\n# Form\n"),
  "references/r.md": Buffer.from("# Reference\r\n"),
  "scripts/fill_form.py": Buffer.from("\ufeffprint('form')\n"),
  "assets/template.pdf": PDF,
  "assets/logo.png": Buffer.from([137, 80, 78, 71, 0, 255])
};
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function copy(folder = true, workspaceId?: string) {
  const root = await mkdtemp(join(tmpdir(), "sf4-cli-"));
  roots.push(root);
  await writeFile(
    join(root, "catalyst.yaml"),
    `instances:\n  local:\n    url: https://catalyst.test\n${workspaceId === undefined ? "" : `    workspace: ${workspaceId}\n`}defaultInstance: local\nagents: []\nskills: [skills/*/SKILL.md]\n`
  );
  if (folder)
    for (const [path, bytes] of Object.entries(content)) {
      const target = join(root, "skills/form", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  return root;
}

export function useSkillCliWorlds() {
  const { startApi } = useSkillWorlds();
  async function fixture() {
    const world = { api: await startApi() };
    const created = await world.api.call("workspaces.create", { payload: { name: "Skill CLI" } });
    expect(created.statusCode, created.body).toBe(200);
    const workspaceId = z.object({ id: z.string() }).parse(created.json()).id;
    const forward = createTestFetch(world.api);
    const calls: Array<{ operation: string; body: Record<string, unknown>; url: URL }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const operation = Object.values(apiOperations).find(
        (op) =>
          op.method === request.method &&
          new RegExp(`^${op.path.replace(/:[^/]+/gu, "[^/]+")}$`, "u").test(url.pathname)
      );
      if (!operation) throw new Error(`Unexpected URL ${url}`);
      const body = request.body
        ? z.record(z.string(), z.unknown()).parse(await request.clone().json())
        : {};
      calls.push({ operation: operation.id, body, url });
      if (operation.id === "access_tokens.exchange")
        return Response.json({ accessToken: "access", expiresAt: "2099-01-01T00:00:00Z" });
      request.headers.delete("authorization");
      return forward(request);
    };
    const run = async (
      root: string,
      command: "push" | "pull" | "diff" | "validate",
      extra = {}
    ) => {
      const out: string[] = [],
        err: string[] = [];
      const code = await runConfigCommand(command, {
        cwd: root,
        env: { CATALYST_API_KEY: "test" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        ...extra
      });
      const result = { code, out: out.join(""), err: err.join("") };
      return result;
    };
    return {
      world,
      workspaceId,
      fetchImpl,
      calls,
      run,
      copy: (folder = true) => copy(folder, workspaceId)
    };
  }

  return { fixture };
}
