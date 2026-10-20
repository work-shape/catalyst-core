import { createTestFetch } from "../support/test-instance";
import { testOperations } from "../support/operations";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { asUserId } from "@work-shape/catalyst-core";
import {
  canonicalizeAgentConfig,
  readManifest,
  readWorkingCopy,
  runCli,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "../support/asset-revisions";
import {
  createTemporaryDirectory,
  writeMinimalManifest,
  recordEmptyPull,
  heldAssetId,
  instanceHolding,
  agentConfig,
  skillConfig
} from "../support/config-cli";

describe("a working copy bound to a workspace", () => {
  /**
   * An instance with a workspace Team that owns the skill `team-notes`, a key that writes the
   * instance's assets, and an empty working copy. `guardrails` lists guardrails in it.
   */
  async function boundFixture(guardrails = false) {
    const syncs: unknown[] = [];
    /** Every call that writes, in the order the CLI sends them. */
    const writes: Array<{ path: string; body: unknown }> = [];
    const { fixture } = await instanceHolding(
      {
        defaultAgentName: "assistant",
        agents: [agentConfig("The instance's own.")],
        skills: [],
        ...(guardrails ? { guardrails: [] } : {})
      },
      syncs,
      heldAssetId,
      {},
      true
    );
    const { clientInstanceId, store } = fixture;
    const owner = await store.users.createUser({
      clientInstanceId,
      displayLabel: "Owner",
      roles: ["user"],
      permissions: []
    });
    const team = await store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: owner.id
    });
    const scope = { kind: "workspace" as const, workspaceId: team.id };
    await applyAtCurrentRevisions(store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "team-notes",
          config: skillConfig("team-notes", "Notes."),
          scope
        }
      ]
    });
    // A key that writes the instance's assets: the root it is used in names the owner.
    const principal = await store.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Team CLI",
      permissions: ["config_assets.read", "config_assets.write"]
    });
    const credential = await store.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "team CLI",
      scopes: ["config_assets:read", "config_assets:write"]
    });
    // No legacy key carries a right on guardrails: the key is granted them as rows.
    for (const action of guardrails
      ? ["guardrail.read", "guardrail.write", "guardrail.delete"]
      : []) {
      await store.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action,
        effect: "allow",
        scopeKind: "instance",
        grantedBy: asUserId("usr_config_cli_test")
      });
    }
    const serverFetch = createTestFetch(fixture.server);
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === testOperations["access_tokens.exchange"].path) {
        return serverFetch(request.url, {
          method: request.method,
          headers: { authorization: `Bearer ${credential.secret}` }
        });
      }
      if (path === testOperations["assets.sync"].path) {
        syncs.push(JSON.parse(await request.clone().text()));
      }
      if (request.method !== "GET") {
        writes.push({
          path: `${request.method} ${path}`,
          body: JSON.parse(await request.clone().text())
        });
      }
      return serverFetch(request);
    };
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    if (guardrails) {
      await writeFile(
        resolve(directory, "catalyst.yaml"),
        `${await readFile(resolve(directory, "catalyst.yaml"), "utf8")}guardrails:\n  - guardrails/*/guardrail.yaml\n`,
        "utf8"
      );
    }
    const output: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_team" },
      fetchImpl,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text)
    };
    return { fixture, team, scope, syncs, writes, directory, output, options };
  }

  it("binds with pull --workspace, pulls and pushes what the workspace owns, and is bound once", async () => {
    const { fixture, team, scope, syncs, directory, output, options } = await boundFixture();
    const { clientInstanceId, store } = fixture;

    expect(
      await runConfigCommand("pull", { ...options, workspace: team.id }),
      output.join("")
    ).toBe(0);
    expect(output.join("")).toContain(`Bound this working copy to workspace '${team.id}'.`);
    expect(await readFile(join(directory, "catalyst.yaml"), "utf8")).toContain(
      `    workspace: ${team.id}\n`
    );
    // The workspace's skill, and nothing of the instance's own.
    const pulled = await readWorkingCopy(directory, await readManifest(directory));
    expect(pulled.skills.map((skill) => skill.name)).toEqual(["team-notes"]);
    expect(pulled.agents).toEqual([]);

    // A push of the bound root writes into the workspace.
    await mkdir(join(directory, "agents"), { recursive: true });
    await writeFile(
      join(directory, "agents", "team-helper.agent.yaml"),
      serializeAgentYaml(
        canonicalizeAgentConfig({
          ...agentConfig("Read the notes.", { name: "team-helper" }),
          toolNames: ["read_skill"],
          skillNames: ["team-notes"]
        })
      )
    );
    expect(await runConfigCommand("push", options), output.join("")).toBe(0);
    expect(syncs.at(-1)).toMatchObject({ workspaceId: team.id });
    expect(syncs.at(-1)).not.toHaveProperty("defaultAgentName");
    expect(
      (
        await store.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "agent",
          name: "team-helper"
        })
      )?.scope
    ).toEqual(scope);

    // Bound once: another workspace is pulled into a directory of its own.
    output.length = 0;
    expect(await runConfigCommand("pull", { ...options, workspace: "cws_other" })).not.toBe(0);
    expect(output.join("")).toContain(`This working copy is bound to workspace '${team.id}'.`);
    // A root that pulled the instance's own assets is not bound afterwards.
    const instanceRoot = await createTemporaryDirectory();
    await writeMinimalManifest(instanceRoot, "https://catalyst.test");
    await recordEmptyPull(instanceRoot);
    output.length = 0;
    expect(
      await runConfigCommand("pull", { ...options, cwd: instanceRoot, workspace: team.id })
    ).not.toBe(0);
    expect(output.join("")).toContain("This working copy holds the instance's own assets");
  });

  // From the review of WS-OWN-1a: the commands of one asset ignored the binding and addressed
  // the instance's own assets.
  it("addresses the bound workspace with the commands of one asset, as its config commands do", async () => {
    const { team, writes, directory, output, options } = await boundFixture();
    expect(
      await runConfigCommand("pull", { ...options, workspace: team.id }),
      output.join("")
    ).toBe(0);
    const cli = async (...args: string[]) => {
      const out: string[] = [];
      const code = await runCli(args, {
        cwd: directory,
        env: options.env,
        fetchImpl: options.fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => out.push(text)
      });
      return { code, out: out.join("") };
    };

    const listed = await cli("skill", "list", "--json");
    expect(listed.code, listed.out).toBe(0);
    expect(listed.out).toContain('"team-notes"');

    await mkdir(join(directory, "skills", "team-guide"), { recursive: true });
    await writeFile(
      join(directory, "skills", "team-guide", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("team-guide", "A guide."))
    );
    writes.length = 0;
    const written = await cli(
      "skill",
      "put",
      "team-guide",
      "--from",
      "skills/team-guide",
      "--if-revision",
      "new"
    );
    expect(written.code, written.out).toBe(0);
    expect(writes).toEqual([
      {
        path: "PUT /api/v1/assets/skill/team-guide",
        body: expect.objectContaining({ workspaceId: team.id })
      }
    ]);
  });

  it("pushes a guardrail of the bound root as the workspace's, and prunes it there", async () => {
    const { fixture, team, scope, writes, directory, output, options } = await boundFixture(true);
    const { clientInstanceId, store } = fixture;
    expect(
      await runConfigCommand("pull", { ...options, workspace: team.id }),
      output.join("")
    ).toBe(0);

    const guardrail = {
      name: "team_no_codes",
      displayName: "No codes in Team's skills",
      on: "asset.before_write",
      filter: { kind: "skill" },
      check: { kind: "pattern", pattern: "CODE-[0-9]+", reason: "Skills hold no codes." },
      outcome: "block"
    };
    await mkdir(resolve(directory, "guardrails", guardrail.name), { recursive: true });
    await writeFile(
      resolve(directory, "guardrails", guardrail.name, "guardrail.yaml"),
      [
        `name: ${guardrail.name}`,
        `displayName: ${guardrail.displayName}`,
        `on: ${guardrail.on}`,
        "filter:",
        "  kind: skill",
        "check:",
        "  kind: pattern",
        `  pattern: ${guardrail.check.pattern}`,
        `  reason: ${guardrail.check.reason}`,
        `outcome: ${guardrail.outcome}`,
        ""
      ].join("\n"),
      "utf8"
    );
    output.length = 0;
    writes.length = 0;
    expect(await runConfigCommand("push", options), output.join("")).toBe(0);
    expect(output.join("")).toContain(`Wrote guardrail:${guardrail.name} as draft revision 1`);
    expect(writes).toEqual([
      {
        path: "POST /api/v1/assets/guardrail/validate",
        body: { config: guardrail, workspaceId: team.id }
      },
      {
        path: `PUT /api/v1/assets/guardrail/${guardrail.name}`,
        body: { config: guardrail, expectedRevision: null, workspaceId: team.id }
      }
    ]);
    const stored = await store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "guardrail",
      name: guardrail.name
    });
    expect(stored?.scope).toEqual(scope);

    // What the push wrote is what the bound root holds: nothing to push, no difference.
    output.length = 0;
    expect(await runConfigCommand("diff", options), output.join("")).toBe(0);

    // A prune deletes it in the workspace that owns it.
    await rm(resolve(directory, "guardrails", guardrail.name), { recursive: true });
    writes.length = 0;
    output.length = 0;
    expect(await runConfigCommand("push", { ...options, prune: true }), output.join("")).toBe(0);
    expect(writes).toEqual([
      {
        path: `POST /api/v1/assets/guardrail/${guardrail.name}/delete`,
        body: { expectedRevision: 1, workspaceId: team.id }
      }
    ]);
    expect(
      (
        await store.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "guardrail",
          name: guardrail.name
        })
      )?.status
    ).toBe("deleted");
  });
});
