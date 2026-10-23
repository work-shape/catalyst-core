import { createTestFetch } from "../support/test-instance";
import { testOperations } from "../support/operations";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "@work-shape/catalyst-cli";
import { grantKaiWorkspace, inDays, setupPersonalKeyInstance } from "../support/personal-api-keys";
import { clientInstanceId as accessInstanceId } from "../support/access-instance";
import { kaiWorkingCopy, createTemporaryDirectory } from "../support/config-cli";

describe("catalyst login", () => {
  it("saves the key of a confirmed code, and the CLI then works inside the person's workspace only", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const cwd = await kaiWorkingCopy(t.kaiTeam);
    const configHome = await createTemporaryDirectory();
    const env = { CATALYST_CONFIG_HOME: configHome };
    const fetchImpl = createTestFetch(t.instance);
    const output: string[] = [];
    const stdout = (text: string) => output.push(text);
    let confirmed = false;

    // The person confirms in Settings while the CLI waits for it.
    const sleep = async () => {
      if (confirmed) return;
      const code = /code ([A-Z]{4}-[A-Z]{4})/u.exec(output.join(""))?.[1];
      expect(code).toBeDefined();
      await t.expectOk(t.kai.id, "me.connect_codes.confirm", {
        params: { userCode: code ?? "" },
        payload: {
          name: "Mini",
          scopes: [`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}`],
          expiresAt: inDays(30)
        }
      });
      confirmed = true;
    };
    expect(await runCli(["login"], { cwd, env, fetchImpl, stdout, sleep })).toBe(0);
    const printed = output.join("");
    expect(printed).toContain("https://catalyst.test/settings/you/api-keys?code=");
    // A plain login asks for no level: the person ticks what the key gets.
    expect(printed).not.toContain("level=use");
    expect(printed).toContain("Logged in to https://catalyst.test with the key 'Mini'");
    expect(printed).toContain("See and revoke it at https://catalyst.test/settings/you/api-keys.");

    // The key is in a file only its user reads, and on no line the CLI printed.
    const path = join(configHome, "credentials.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    const apiKey = JSON.stringify(saved).match(/cat\.apic_[^"]+/u)?.[0];
    expect(apiKey).toBeDefined();
    expect(printed).not.toContain(apiKey ?? "");

    output.length = 0;
    expect(await runCli(["config", "push"], { cwd, env, fetchImpl, stdout })).toBe(0);
    expect(output.join("")).toContain("Pushed 1 agent");
    output.length = 0;
    expect(await runCli(["config", "list"], { cwd, env, fetchImpl, stdout })).toBe(0);
    expect(output.join("")).toContain("agent\tkai-tax\t-\t-");

    // A pull reads what the key may read and nothing of the whole instance.
    const paths: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      paths.push(new URL(request.url).pathname);
      return fetchImpl(request);
    };
    output.length = 0;
    expect(await runCli(["config", "pull"], { cwd, env, fetchImpl: recording, stdout })).toBe(0);
    expect(output.join("")).toContain("Pulled 1 agent, 0 skills.");
    expect(paths).not.toContain(testOperations["config_assets.get_overview"].path);
    expect(await readFile(join(cwd, "agents", "kai-tax.agent.yaml"), "utf8")).toContain(
      "# Pulled from production.\n"
    );

    // An agent of another workspace is refused, with the right that is missing.
    const otherTeam = await t.sharedWorkspace("Other team");
    const elsewhere = await kaiWorkingCopy(otherTeam, "other");
    const errors: string[] = [];
    expect(
      await runCli(["config", "push"], {
        cwd: elsewhere,
        env,
        fetchImpl,
        stdout,
        stderr: (text) => errors.push(text)
      })
    ).toBe(1);
    expect(errors.join("")).toMatch(/other/u);
    expect(
      await t.stores.configAssets.getConfigAsset({
        clientInstanceId: accessInstanceId,
        kind: "agent",
        name: "other"
      })
    ).toBeUndefined();

    // Revoked in Settings, the saved key is refused on the next call.
    const keys = await t.expectOk(t.kai.id, "me.api_keys.list");
    const keyId = /"id":"(apic_[^"]+)"/u.exec(keys.body)?.[1] ?? "";
    await t.expectOk(t.kai.id, "me.api_keys.revoke", { params: { keyId } });
    const refused: string[] = [];
    expect(
      await runCli(["config", "list"], {
        cwd,
        env,
        fetchImpl,
        stdout,
        stderr: (text) => refused.push(text)
      })
    ).toBe(1);
    expect(refused.join("")).toContain("revoked");

    expect(await runCli(["logout"], { cwd, env, stdout })).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, instances: {} });
  });

  it("refuses a saved key file that others may read", async () => {
    const cwd = await kaiWorkingCopy();
    const configHome = await createTemporaryDirectory();
    await writeFile(
      join(configHome, "credentials.json"),
      JSON.stringify({ version: 1, instances: {} }),
      { mode: 0o644 }
    );
    // Creation modes are masked by umask; this fixture must actually be readable by others.
    await chmod(join(configHome, "credentials.json"), 0o644);
    const errors: string[] = [];
    expect(
      await runCli(["config", "list"], {
        cwd,
        env: { CATALYST_CONFIG_HOME: configHome },
        stderr: (text) => errors.push(text)
      })
    ).toBe(1);
    expect(errors.join("")).toContain("can be read by other users");
  });
});
