import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  canonicalizeAgentConfig,
  readStateFile,
  serializeAgentYaml,
  runCli,
  writeStateFile,
  type CatalystState
} from "@work-shape/catalyst-cli";
import { createTestFetch, type TestInstance } from "./support/test-instance";
import { testOperations } from "./support/operations";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { guardedEvents } from "./support/guardrails";

// AD-3, Platform Access check 66: the CLI writes an agent's one shared draft, names the draft
// revision it saw, publishes with a person's key and with no other, and tells who changed a
// draft it would write over.

const directories: string[] = [];
const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A person's working copy holds what one workspace owns, bound to it by its id: only a release
 * key pushes the instance's own assets, from an unbound root. A workspace's working copy can
 * start unbound too, and its first pull binds it.
 */
const manifest = (workspaceId?: string) =>
  `instances:\n  local:\n    url: https://catalyst.test\n${workspaceId === undefined ? "" : `    workspace: ${workspaceId}\n`}defaultInstance: local\nagents:\n  - agents/*.agent.yaml\nskills:\n  - skills/*/SKILL.md\n`;
const AGENT = "kai-helper";
const AGENT_KEY = `agent:${AGENT}`;

/** A working copy bound to the workspace, or an unbound one without it. */
async function workingCopy(workspaceId?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "catalyst-agent-drafts-"));
  directories.push(directory);
  await writeFile(join(directory, "catalyst.yaml"), manifest(workspaceId), "utf8");
  return directory;
}

/**
 * The agent `kai-helper`, live at revision 1 with no draft: owned by the Shared Workspace
 * `team`, or by the instance.
 */
async function setup(
  guardrails: Record<string, unknown> = {},
  owner: "workspace" | "instance" = "workspace"
) {
  const t = await setupAccessInstance({
    modules: { assetManagement: { enabled: true } },
    server: (stores) => ({
      // The CLI sends its token: the sign-in takes it beside the test header.
      authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" },
      ...(Object.keys(guardrails).length > 0
        ? { operations: { events: guardedEvents(stores, guardrails).events } }
        : {})
    })
  });
  instances.push(t);
  const team = await t.sharedWorkspace("Kai's team");
  await t.expectOk(t.admin.id, "assets.put", {
    params: { kind: "agent", name: AGENT },
    payload: {
      config: agent(AGENT, { instructions: "Help." }),
      expectedRevision: null,
      ...(owner === "workspace" ? { workspaceId: team } : {})
    }
  });
  const live = async () => {
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: AGENT
    });
    if (!asset) throw new Error(`No agent '${AGENT}'`);
    return asset;
  };
  const draft = async () =>
    t.stores.agentProposals.get({ clientInstanceId, agentId: (await live()).id });
  const version = async () =>
    (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).version;
  return { t, team, live, draft, version };
}

/**
 * The CLI signed in as one caller: a person through their personal key, or a service
 * principal with the scopes of the operated instances' release key. The key exchange is
 * answered here; every other call reaches the instance as that caller.
 */
function cliAs(
  instance: TestInstance,
  caller: { user: string } | { service: string; scopes: string },
  cwd: string
) {
  const serverFetch = createTestFetch(
    instance,
    "user" in caller
      ? {
          "x-test-user": caller.user,
          "x-test-key": "personal",
          [SCOPES_HEADER]: "config_assets:read config_assets:write config_assets:publish"
        }
      : { [SERVICE_HEADER]: caller.service, [SCOPES_HEADER]: caller.scopes }
  );
  const sent: Array<{ path: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === testOperations["access_tokens.exchange"].path) {
      return new Response(
        JSON.stringify({
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (request.method !== "GET") {
      sent.push({ path, body: JSON.parse(await request.clone().text()) });
    }
    return serverFetch(request);
  };
  const run = async (args: string[], answers?: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const code = await runCli(args, {
      cwd,
      env: { CATALYST_API_KEY: "cat_test" },
      fetchImpl,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      // Without answers nobody can be asked: the run has no terminal.
      ...(answers
        ? {
            prompt: (question: string) => {
              asked.push(question);
              return Promise.resolve(answers.shift() ?? "");
            }
          }
        : {})
    });
    return { code, out: out.join(""), err: err.join(""), asked };
  };
  /** Runs the command and expects it done, with what it printed where it is not. */
  const ok = async (args: string[], answers?: string[]) => {
    const result = await run(args, answers);
    expect(result.code, `${result.out}${result.err}`).toBe(0);
    return result;
  };
  return { run, ok, sent };
}

const agentFile = (directory: string) => join(directory, "agents", `${AGENT}.agent.yaml`);

async function editInstructions(directory: string, instructions: string): Promise<void> {
  const path = agentFile(directory);
  const file = await readFile(path, "utf8");
  const edited = file.replace(/^instructions: .*$/mu, `instructions: ${instructions}`);
  expect(edited).not.toBe(file);
  await writeFile(path, edited, "utf8");
}

async function agentBaseline(directory: string) {
  return (await readStateFile(join(directory, STATE_FILENAME))).instances.local?.assets?.[
    AGENT_KEY
  ];
}

describe("catalyst config and agent drafts (Platform Access 66)", () => {
  it("pushes a changed agent as its draft, pulls and diffs against live, and names the draft", async () => {
    const { t, team, live, draft, version } = await setup();
    const before = await live();
    const stateVersion = await version();
    const mine = await workingCopy(team);
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull"]);
    expect(await agentBaseline(mine)).toMatchObject({ revision: 1, draftRevision: null });

    await editInstructions(mine, "Answer in short sentences.");
    const pushed = await cli.run(["config", "push"]);
    expect(pushed.code, pushed.err).toBe(0);
    expect(pushed.out).toContain(
      "agent:kai-helper: draft revision 1; live revision 1 is unchanged until it is published."
    );
    expect(pushed.out).toContain("catalyst agent publish kai-helper --revision 1");
    // Nothing is live: the revision, the runtime snapshot's version and the content stay.
    expect(await live()).toMatchObject({ revision: before.revision, config: before.config });
    expect(await version()).toBe(stateVersion);
    expect(await draft()).toMatchObject({
      revision: 1,
      config: { instructions: "Answer in short sentences." }
    });
    // The baseline names the live revision and the draft revision, not one for the other.
    expect(await agentBaseline(mine)).toMatchObject({
      revision: 1,
      draftRevision: 1,
      draftPushed: true
    });

    // The diff compares against live and names the pending draft with its author.
    const diffed = await cli.run(["config", "diff"]);
    expect(diffed.code).toBe(1);
    expect(diffed.out).toContain("agent:kai-helper: pushed as a draft, not live");
    expect(diffed.out).toMatch(
      /agent:kai-helper: pending draft revision 1 by Admin at \S+; not live/u
    );
    expect(diffed.out).toContain("+instructions: Answer in short sentences.");
    expect((await cli.run(["config", "push"])).out).toContain("No local changes to push.");

    // Another working copy pulls the live revision and lists the draft with its author.
    const other = await workingCopy(team);
    const pulled = await cliAs(t.instance, { user: t.admin.id }, other).run(["config", "pull"]);
    expect(pulled.code, pulled.err).toBe(0);
    expect(pulled.out).toMatch(
      /Pending agent drafts, not live[^\n]*\n {2}agent:kai-helper: draft revision 1 by Admin at \S+/u
    );
    expect(await readFile(agentFile(other), "utf8")).toContain(
      `instructions: ${String(before.config?.instructions)}`
    );
    expect(await agentBaseline(other)).toMatchObject({ revision: 1, draftRevision: 1 });
    expect(await agentBaseline(other)).not.toHaveProperty("draftPushed");

    // A pull of the pushing copy writes the live revision too, not what it pushed.
    await cli.ok(["config", "pull"]);
    expect(await readFile(agentFile(mine), "utf8")).toContain(
      `instructions: ${String(before.config?.instructions)}`
    );
  });

  // The verifier of AD-1: the CLI recorded the draft revision as the agent's base, so the push
  // after a push was made against a live revision the agent never had.
  it("pushes again on the live base with the draft revision it was given", async () => {
    const { t, team, live, draft } = await setup();
    const mine = await workingCopy(team);
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull"]);
    await editInstructions(mine, "First.");
    await cli.ok(["config", "push"]);
    // A discard keeps the counter: the next draft is revision 2 on live revision 1.
    expect((await cli.run(["agent", "discard", AGENT, "--revision", "1"])).out).toContain(
      "Discarded draft revision 1 of agent 'kai-helper'; its live revision is unchanged."
    );
    expect(await draft()).toBeUndefined();
    await cli.ok(["config", "pull"]);
    await editInstructions(mine, "Second.");
    expect((await cli.run(["config", "push"])).out).toContain(
      "agent:kai-helper: draft revision 2;"
    );
    await editInstructions(mine, "Third.");
    const third = await cli.run(["config", "push"]);
    expect(third.code, third.err).toBe(0);
    expect(third.out).toContain("agent:kai-helper: draft revision 3; live revision 1");
    expect(cli.sent.filter((call) => call.path.endsWith("/assets/sync")).at(-1)).toMatchObject({
      body: { items: [{ expectedRevision: 1, expectedDraftRevision: 2 }] }
    });
    expect(await live()).toMatchObject({ revision: 1 });
    expect(await draft()).toMatchObject({ revision: 3, config: { instructions: "Third." } });
  });

  it("refuses a push over a draft somebody changed since the last pull, and names them", async () => {
    const { t, team, live, draft } = await setup();
    const mine = await workingCopy(team);
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull"]);
    // Root saves a draft on the agent page after the pull.
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "agent", name: AGENT },
      payload: {
        config: { ...(await live()).config, instructions: "Root's draft." },
        expectedRevision: 1,
        expectedDraftRevision: null,
        workspaceId: team
      }
    });

    await editInstructions(mine, "Mine.");
    const refused = await cli.run(["config", "push"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Push conflict; nothing was applied.");
    expect(refused.err).toMatch(
      /- agent:kai-helper: its draft changed since the last pull: draft revision 1, written by Root at \S+\./u
    );
    expect(refused.err).toContain("catalyst config pull --only agent:kai-helper");
    expect(await draft()).toMatchObject({ revision: 1, config: { instructions: "Root's draft." } });
    expect(await live()).toMatchObject({ revision: 1 });

    // A put that read no draft is refused the same way, and names the fence that writes over it.
    const blind = await cli.run([
      "agent",
      "put",
      AGENT,
      "--from",
      agentFile(mine),
      "--if-revision",
      "1"
    ]);
    expect(blind.code).toBe(1);
    expect(blind.err).toMatch(
      /Agent 'kai-helper' has draft revision 1 by Root at \S+\. Read it with 'catalyst agent show kai-helper'; the put writes over it with --if-draft-revision 1\./u
    );
    expect(await draft()).toMatchObject({ revision: 1, config: { instructions: "Root's draft." } });
    expect(
      (
        await cli.run([
          "skill",
          "put",
          "x",
          "--from",
          mine,
          "--if-revision",
          "1",
          "--if-draft-revision",
          "1"
        ])
      ).err
    ).toContain("--if-draft-revision names the draft of an agent.");

    // The pull records the draft revision and names Root; the push after it writes over it.
    const pulled = await cli.run(["config", "pull", "--only", AGENT_KEY]);
    expect(pulled.out).toMatch(/agent:kai-helper: draft revision 1 by Root at /u);
    await editInstructions(mine, "Mine after all.");
    const pushed = await cli.run(["config", "push"]);
    expect(pushed.code, pushed.err).toBe(0);
    expect(await draft()).toMatchObject({
      revision: 2,
      config: { instructions: "Mine after all." },
      author: { userId: t.admin.id, release: false }
    });
  });

  it("publishes a workspace's agent it pushed with an admin's personal key, once answered", async () => {
    const { t, team, live, draft, version } = await setup();
    const stateVersion = await version();
    const mine = await workingCopy(team);
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull"]);
    await editInstructions(mine, "Published from the CLI.");

    const published = await cli.run(["config", "push", "--publish"], ["yes"]);
    expect(published.code, published.err).toBe(0);
    expect(published.asked).toHaveLength(1);
    expect(published.out).toContain("agent:kai-helper: draft revision 1;");
    expect(published.out).toContain(
      "Published draft revision 1 of agent 'kai-helper' as live revision 2 in place of revision 1."
    );
    expect(await live()).toMatchObject({
      revision: 2,
      config: { instructions: "Published from the CLI." }
    });
    expect(await version()).toBeGreaterThan(stateVersion);
    expect(await draft()).toBeUndefined();
    const baseline = await agentBaseline(mine);
    expect(baseline).toMatchObject({ revision: 2, draftRevision: null });
    expect(baseline).not.toHaveProperty("draftPushed");
    expect((await cli.run(["config", "diff"])).out).toContain("No differences.");
  });

  it("publishes an instance agent with an admin's personal key and no terminal", async () => {
    const { t, live, draft } = await setup({}, "instance");
    const mine = await workingCopy();
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull"]);
    await editInstructions(mine, "Pushed by a person.");

    // A person's push of the instance's own assets is no release: it is refused whole.
    const pushed = await cli.run(["config", "push", "--publish"]);
    expect(pushed.code).toBe(1);
    expect(pushed.err).toContain(
      "A batch names the workspace it belongs to. Only a release writes the instance's own assets"
    );
    expect(await live()).toMatchObject({ revision: 1 });
    expect(await draft()).toBeUndefined();

    // The one-asset commands: put writes the draft, show names it, publish makes it live.
    const file = join(mine, "kai-helper.yaml");
    await writeFile(
      file,
      (await readFile(agentFile(mine), "utf8")).replace(
        /^instructions: .*$/mu,
        "instructions: Put as a draft."
      )
    );
    const put = await cli.run(["agent", "put", AGENT, "--from", file, "--if-revision", "1"]);
    expect(put.out).toContain(
      "Wrote agent 'kai-helper' as draft revision 1; live revision 1 is unchanged until it is published with 'catalyst agent publish kai-helper --revision 1'."
    );
    expect((await cli.run(["agent", "show", AGENT])).out).toMatch(
      /pending draft: draft revision 1 by Admin at \S+, not live/u
    );
    const over = await cli.run([
      ...["agent", "put", AGENT, "--from", file, "--if-revision", "1"],
      ...["--if-draft-revision", "1"]
    ]);
    expect(over.out, over.err).toContain("Wrote agent 'kai-helper' as draft revision 2;");
    const named = await cli.run(["agent", "publish", AGENT, "--revision", "2"]);
    expect(named.code, named.err).toBe(0);
    expect(named.asked).toEqual([]);
    expect(named.out).toContain(
      "Published draft revision 2 of agent 'kai-helper' as live revision 2 in place of revision 1."
    );
    expect(await live()).toMatchObject({
      revision: 2,
      config: { instructions: "Put as a draft." }
    });
  });

  it("prints the waiting Operation Run and exits non-zero where a guardrail asks for an approval", async () => {
    const { t, team, live, draft } = await setup({
      "review-agent-publish": {
        displayName: "Review agent publishes",
        on: "agent.before_publish",
        check: { kind: "pattern", pattern: "Needs review", reason: "Review this change." },
        outcome: "require_approval"
      }
    });
    const mine = await workingCopy(team);
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull"]);
    await editInstructions(mine, "Needs review.");

    const held = await cli.run(["config", "push", "--publish"], ["yes"]);
    expect(held.code, held.err).toBe(3);
    expect(held.out).toContain("agent:kai-helper: draft revision 1;");
    expect(held.err).toMatch(
      /agent:kai-helper: Waits for an approval on the instance; nothing has changed yet \(.*Operation Run \S+\)/u
    );
    expect(await live()).toMatchObject({ revision: 1 });
    expect(await draft()).toMatchObject({ revision: 1 });
  });

  it("writes drafts with a service principal's key and publishes nothing, saying why", async () => {
    const { t, live, draft } = await setup({}, "instance");
    const mine = await workingCopy();
    const release = cliAs(
      t.instance,
      { service: "sp_release", scopes: "config_assets:read config_assets:release" },
      mine
    );
    await release.ok(["config", "pull"]);
    await editInstructions(mine, "Released instructions.");

    const pushed = await release.run(["config", "push", "--publish"]);
    expect(pushed.code).toBe(1);
    expect(pushed.out).toContain("agent:kai-helper: draft revision 1;");
    expect(pushed.err).toContain(
      "agent:kai-helper: nothing was published; draft revision 1 stays a draft."
    );
    expect(pushed.err).toContain("writes agent drafts and publishes none (AP-10)");
    expect(pushed.err).toContain("catalyst agent publish kai-helper --revision 1");
    expect(await live()).toMatchObject({ revision: 1 });
    expect(await draft()).toMatchObject({ revision: 1, author: { release: true } });

    const named = await release.run(["agent", "publish", AGENT, "--revision", "1"]);
    expect(named.code).toBe(1);
    expect(named.err).toContain("publishes none (AP-10)");
    expect(await live()).toMatchObject({ revision: 1 });

    // An admin saves the draft on the agent page. The next release push is refused and names
    // them; the release key reads the draft revision it has to name, so one pull lets it push.
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: AGENT },
      payload: {
        config: { ...(await live()).config, instructions: "Edited on the page." },
        expectedRevision: 1,
        expectedDraftRevision: 1
      }
    });
    await editInstructions(mine, "Released again.");
    const refused = await release.run(["config", "push"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/draft revision 2, written by Admin at /u);
    const pulled = await release.run(["config", "pull"]);
    expect(pulled.out).toMatch(/agent:kai-helper: draft revision 2 by Admin at /u);
    expect(await agentBaseline(mine)).toMatchObject({ revision: 1, draftRevision: 2 });
    await editInstructions(mine, "Released again.");
    expect((await release.ok(["config", "push"])).out).toContain(
      "agent:kai-helper: draft revision 3;"
    );
    expect(await draft()).toMatchObject({ revision: 3, author: { release: true } });

    // The operator publishes the release-written draft with their own key.
    const person = cliAs(t.instance, { user: t.admin.id }, mine);
    await person.ok(["agent", "publish", AGENT, "--revision", "3"]);
    expect(await live()).toMatchObject({
      revision: 2,
      config: { instructions: "Released again." }
    });
  });

  it("gives tools to an agent a release push left a draft of, live at once, and the draft keeps them", async () => {
    const { t, live, draft } = await setup({}, "instance");
    const mine = await workingCopy();
    const release = cliAs(
      t.instance,
      { service: "sp_release", scopes: "config_assets:read config_assets:release" },
      mine
    );
    await release.ok(["config", "pull"]);
    await editInstructions(mine, "Released instructions.");
    await release.ok(["config", "push"]);
    expect(await draft()).toMatchObject({ revision: 1, author: { release: true } });

    // The release key gives nothing: only a person may publish.
    const refused = await release.run(["agent", "give-tools", AGENT, "--tool", "known.tool"]);
    expect(refused.code).toBe(1);
    expect(await live()).toMatchObject({ revision: 1 });

    const person = cliAs(t.instance, { user: t.admin.id }, mine);
    const given = await person.run(["agent", "give-tools", AGENT, "--tool", "known.tool"]);
    expect(given.code, given.err).toBe(0);
    expect(given.out).toContain(
      "Gave agent 'kai-helper' 1 tool as live revision 2 in place of revision 1: known.tool."
    );
    expect(await live()).toMatchObject({
      revision: 2,
      config: { instructions: "Help.", toolNames: ["known.tool"] }
    });
    expect(await draft()).toMatchObject({
      revision: 2,
      baseRevision: 2,
      author: { release: true },
      config: { instructions: "Released instructions.", toolNames: ["known.tool"] }
    });

    // A revision the live agent moved past is refused; the draft is still publishable.
    const stale = await person.run([
      ...["agent", "give-tools", AGENT, "--tool", "second.tool", "--if-revision", "1"]
    ]);
    expect(stale.code).toBe(1);
    expect(await live()).toMatchObject({ revision: 2 });
    await person.ok(["agent", "publish", AGENT, "--revision", "2"]);
    expect(await live()).toMatchObject({
      revision: 3,
      config: { instructions: "Released instructions.", toolNames: ["known.tool"] }
    });
  });

  it("refuses an agent push with a state file from before agent drafts until one pull", async () => {
    const { t, team, draft } = await setup();
    const mine = await workingCopy(team);
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull"]);
    // The state an earlier CLI wrote: revisions and hashes, no draft revision.
    const path = join(mine, STATE_FILENAME);
    const state: CatalystState = await readStateFile(path);
    for (const baseline of Object.values(state.instances)) {
      for (const asset of Object.values(baseline.assets ?? {})) delete asset.draftRevision;
    }
    await writeStateFile(path, state);
    await editInstructions(mine, "After the upgrade.");

    const refused = await cli.run(["config", "push"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      `${STATE_FILENAME} was written before agents had drafts and does not say which draft revision agent:kai-helper was pulled at. Run 'catalyst config pull' once, then push again.`
    );
    expect(cli.sent).toEqual([]);
    expect(await draft()).toBeUndefined();

    await cli.ok(["config", "pull"]);
    await editInstructions(mine, "After the upgrade.");
    const pushed = await cli.run(["config", "push"]);
    expect(pushed.code, pushed.err).toBe(0);
    expect(await draft()).toMatchObject({ revision: 1 });
  });

  it("asks before it publishes a workspace's agent, and publishes nothing without a terminal", async () => {
    const { t } = await setup();
    const team = await t.sharedWorkspace("Team");
    const mine = await workingCopy();
    const cli = cliAs(t.instance, { user: t.admin.id }, mine);
    await cli.ok(["config", "pull", "--workspace", team]);
    await mkdir(join(mine, "agents"), { recursive: true });
    await writeFile(
      join(mine, "agents", "team-helper.agent.yaml"),
      serializeAgentYaml(
        canonicalizeAgentConfig({
          name: "team-helper",
          displayName: "Team helper",
          instructions: "Help the team.",
          modelProviderId: "local",
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        })
      ),
      "utf8"
    );
    const created = await cli.run(["config", "push"]);
    expect(created.code, created.err).toBe(0);
    const teamAgent = async () =>
      t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "agent",
        name: "team-helper"
      });
    expect(await teamAgent()).toMatchObject({ revision: 1 });

    const path = join(mine, "agents", "team-helper.agent.yaml");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("Help the team.", "Help the team well."),
      "utf8"
    );
    const unasked = await cli.run(["config", "push", "--publish"]);
    expect(unasked.code).toBe(1);
    expect(unasked.out).toContain("agent:team-helper: draft revision 1;");
    expect(unasked.err).toContain("Publishing an agent needs your answer here");
    expect(unasked.err).toContain(
      `catalyst agent publish team-helper --revision 1 --workspace ${team}`
    );
    expect(await teamAgent()).toMatchObject({ revision: 1 });

    const answered = await cli.run(
      ["agent", "publish", "team-helper", "--revision", "1", "--workspace", team],
      ["yes"]
    );
    expect(answered.asked).toHaveLength(1);
    expect(answered.code, answered.err).toBe(0);
    expect(await teamAgent()).toMatchObject({
      revision: 2,
      config: { instructions: "Help the team well." }
    });
  });
});
