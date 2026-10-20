import { createTestFetch, type TestInstance } from "../support/test-instance";
import { testOperations } from "../support/operations";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, serializeAgentYaml, serializeSkillMarkdown } from "@work-shape/catalyst-cli";
import {
  agent as accessAgent,
  clientInstanceId as accessInstanceId,
  recordAuthAdapter
} from "../support/access-instance";
import { setupWorkspaceHolder } from "../support/asset-operations";
import { shownAnswerSchema, createTemporaryDirectory, jsonResponse } from "../support/config-cli";

describe("catalyst asset commands against an instance", () => {
  /**
   * The CLI as one user of the instance: the key exchange is answered here, and every other
   * call reaches the instance signed in as that user. Each request is recorded.
   */
  /** The CLI as `userId`. `answers` are typed at its questions, in order; without them nobody can be asked. */
  function cliAs(
    instance: TestInstance,
    userId: string,
    cwd: string,
    answers?: string[],
    /** Signs in through the user's personal key, as the CLI does, instead of their session. */
    personalKey = false
  ) {
    const serverFetch = createTestFetch(instance, {
      "x-test-user": userId,
      ...(personalKey ? { "x-test-key": "personal" } : {})
    });
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === testOperations["access_tokens.exchange"].path) {
        return jsonResponse(200, {
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      }
      return serverFetch(request);
    };
    const asked: string[] = [];
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli([...args, "--instance", "https://catalyst.test"], {
        cwd,
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        ...(answers
          ? {
              prompt: (question: string) => {
                asked.push(question);
                return Promise.resolve(answers.shift() ?? "");
              }
            }
          : {})
      });
      return { code, out: out.join(""), err: err.join("") };
    };
    return { run, requests, asked };
  }

  it("builds an agent with its own skill in the holder's workspace and is refused outside it", async () => {
    const t = await setupWorkspaceHolder({
      furtherToolNames: ["read_skill"],
      // The CLI sends its token: the sign-in takes it beside the test header.
      server: () => ({
        authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" }
      })
    });
    const cwd = await createTemporaryDirectory();
    await mkdir(join(cwd, "skills", "kai-guide", "references"), { recursive: true });
    await writeFile(
      join(cwd, "skills", "kai-guide", "SKILL.md"),
      serializeSkillMarkdown({
        name: "kai-guide",
        title: "Tax guide",
        description: "What to ask about taxes",
        content: "Ask for the year first."
      })
    );
    await writeFile(join(cwd, "skills", "kai-guide", "references", "rates.md"), "# Rates\n");
    const tax = { toolNames: ["read_skill"], skillNames: ["kai-guide"] };
    await writeFile(join(cwd, "kai-tax.yaml"), serializeAgentYaml(accessAgent("kai-tax", tax)));
    await writeFile(join(cwd, "lena-tax.yaml"), serializeAgentYaml(accessAgent("lena-tax", tax)));
    const { run, requests } = cliAs(t.instance, t.kai.id, cwd);
    const inKai = ["--workspace", t.kaiTeam];

    const context = await run("context");
    expect(context.code, context.err).toBe(0);
    expect(context.out).toMatch(new RegExp(`${t.kaiTeam} {2}Kai's team: .*agent\\.write`, "u"));

    const skill = await run(
      "skill",
      "put",
      "kai-guide",
      "--from",
      "skills/kai-guide",
      "--if-revision",
      "new",
      ...inKai
    );
    expect(skill, skill.err).toMatchObject({
      code: 0,
      out: "Wrote skill 'kai-guide' at revision 1.\n"
    });
    const created = await run(
      "agents",
      "put",
      "kai-tax",
      "--from",
      "kai-tax.yaml",
      "--if-revision",
      "new",
      ...inKai
    );
    expect(created.code, created.err).toBe(0);
    expect((await t.stored("agent", "kai-tax"))?.config).toMatchObject({
      skillNames: ["kai-guide"]
    });
    expect((await t.stored("skill", "kai-guide"))?.config).toMatchObject({
      resources: [{ path: "references/rates.md", content: "# Rates\n" }]
    });

    const listed = await run("agent", "list", ...inKai);
    expect(listed.out).toContain("kai-tax");
    expect(listed.out).not.toContain("assistant");
    expect((await run("agent", "show", "kai-tax", ...inKai)).out).toContain("- kai-guide");
    expect((await run("agent", "history", "kai-tax", ...inKai)).out).toMatch(/^1 +create +Kai/mu);

    // In another workspace, and on the instance, the instance refuses, and the CLI prints
    // what it said.
    const inOther = await run(
      "agent",
      "put",
      "lena-tax",
      "--from",
      "lena-tax.yaml",
      "--if-revision",
      "new",
      ...["--workspace", t.lenaTeam]
    );
    expect(inOther.code).toBe(1);
    expect(inOther.err).toContain(
      "Refused by the instance (HTTP 403 FORBIDDEN): Missing the right 'agent.write'"
    );
    const outside = await run(
      "agent",
      "put",
      "lena-tax",
      "--from",
      "lena-tax.yaml",
      "--if-revision",
      "new"
    );
    expect(outside.code).toBe(1);
    expect(outside.err).toContain(
      "Refused by the instance (HTTP 403 FORBIDDEN): Missing the right 'agent.write'"
    );
    expect(await t.stored("agent", "lena-tax")).toBeUndefined();

    // A write made against a revision the asset is no longer at changes nothing.
    const stale = await run(
      "agent",
      "put",
      "kai-tax",
      "--from",
      "kai-tax.yaml",
      "--if-revision",
      "new",
      ...inKai
    );
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("REVISION_CONFLICT");
    expect(stale.err).toContain("- agent 'kai-tax' is at revision 1");

    // A command line that cannot be sent sends nothing.
    const sent = requests.length;
    const usage = [
      await run("agent", "put", "kai-tax", "--from", "kai-tax.yaml"),
      await run("agent", "put", "kai-tax", "--from", "kai-tax.yaml", "--if-revision", "0"),
      await run("agent", "publish", "kai-tax", "--to", "1"),
      await run("agent", "erase", "kai-tax"),
      await run("agnet")
    ];
    expect(usage.map((result) => result.code)).toEqual([2, 2, 2, 2, 2]);
    expect(requests).toHaveLength(sent);
    await writeFile(join(cwd, "broken.yaml"), "name: [kai-tax\n");
    const broken = await run("agent", "validate", "--from", "broken.yaml");
    expect(broken.code).toBe(1);
    expect(broken.err).toContain(`'${join(cwd, "broken.yaml")}' cannot be read:`);
    const renamed = await run(
      "agent",
      "put",
      "kai-other",
      "--from",
      "kai-tax.yaml",
      "--if-revision",
      "new"
    );
    expect(renamed).toMatchObject({
      code: 2,
      err: "The definition names 'kai-tax', and the command 'kai-other'.\n"
    });

    const deleted = await run("agent", "delete", "kai-tax", "--if-revision", "1", ...inKai);
    expect(deleted, deleted.err).toMatchObject({ code: 0 });
    expect(deleted.out).toContain("its delete is revision 2");
    const reverted = await run(
      "agent",
      "revert",
      "kai-tax",
      "--to",
      "1",
      "--if-revision",
      "2",
      ...inKai
    );
    expect(reverted.code, reverted.err).toBe(0);
    expect((await t.stored("agent", "kai-tax"))?.revision).toBe(3);
  });

  it("puts back what show --json printed, and asks for the model right only where the model changes", async () => {
    const t = await setupWorkspaceHolder({
      server: () => ({
        authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" }
      })
    });
    // An agent on a model binding, written by the superadmin, who manages models. An admin
    // writes agents and does not hold `agent_models.manage`.
    const created = await t.putAgent(
      t.root.id,
      "bound",
      { modelProviderId: undefined, modelBindingId: "plain" },
      "all"
    );
    expect(created.statusCode, created.body).toBe(200);
    const cwd = await createTemporaryDirectory();
    const { run } = cliAs(t.instance, t.admin.id, cwd);

    const shown = await run("agent", "show", "bound", "--json");
    expect(shown.code, shown.err).toBe(0);
    const answer = shownAnswerSchema.parse(JSON.parse(shown.out));
    const { config } = answer;
    await writeFile(
      join(cwd, "bound.json"),
      JSON.stringify({ ...answer, config: { ...config, displayName: "Renamed" } })
    );
    const renamed = await run(
      "agent",
      "put",
      "bound",
      "--from",
      "bound.json",
      "--if-revision",
      "1"
    );
    expect(renamed.code, renamed.err).toBe(0);
    const stored = (
      await t.stores.agentProposals.get({
        clientInstanceId: accessInstanceId,
        agentId: await t.assetId("agent", "bound")
      })
    )?.config;
    expect(stored).toMatchObject({ displayName: "Renamed", modelBindingId: "plain" });
    expect(stored).not.toHaveProperty("revision");

    // Leaving the binding out changes the model the agent runs on: that needs the right.
    const { modelBindingId: _binding, ...unbound } = config;
    await writeFile(join(cwd, "unbound.json"), JSON.stringify(unbound));
    const refused = await run(
      "agent",
      "put",
      "bound",
      "--from",
      "unbound.json",
      "--if-revision",
      "2"
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Missing the right 'agent_models.manage'");
  });
});
