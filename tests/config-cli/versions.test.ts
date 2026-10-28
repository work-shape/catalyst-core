import { describe, expect, it } from "vitest";
import { RELEASE_VERSION } from "@work-shape/catalyst-api-contract";
import { cliCompatibilityError, runCli } from "@work-shape/catalyst-cli";
import { createTemporaryDirectory, writeMinimalManifest } from "../support/config-cli";

describe("CLI/server compatibility", () => {
  it("gives an old CLI the exact current server update command", () => {
    expect(cliCompatibilityError("0.7.0", RELEASE_VERSION)?.message).toBe(
      `Catalyst CLI 0.7.0 does not match server ${RELEASE_VERSION}; run: npm install --global @work-shape/catalyst-cli@${RELEASE_VERSION}`
    );
  });

  it.each(["context", "kinds", "agent list", "config pull", "login", "setup claude-code"])(
    "reports version skew before parsing any body for %s",
    async (command) => {
      const cwd = await createTemporaryDirectory();
      await writeMinimalManifest(cwd, "https://instance.test");
      const errors: string[] = [];
      let calls = 0;
      const code = await runCli([...command.split(" "), "--instance", "https://instance.test"], {
        cwd,
        env: {
          CATALYST_API_KEY: "private-key",
          CATALYST_CONFIG_HOME: await createTemporaryDirectory()
        },
        stdout: () => {},
        stderr: (text) => errors.push(text),
        fetchImpl: async () => {
          calls += 1;
          return new Response("<html>private response body</html>", {
            headers: { "catalyst-server-version": "0.7.0" }
          });
        }
      });
      expect(code).toBe(1);
      expect(calls).toBe(1);
      expect(errors.join("")).toContain(
        `Catalyst CLI ${RELEASE_VERSION} does not match server 0.7.0; run: npm install --global @work-shape/catalyst-cli@0.7.0`
      );
      expect(errors.join("")).not.toContain("private");
      expect(errors.join("")).not.toContain("unexpected response");
    }
  );

  it("an older CLI receives the exact update command for a newer server before parsing", async () => {
    const errors: string[] = [];
    const code = await runCli(["context", "--instance", "https://instance.test"], {
      cwd: await createTemporaryDirectory(),
      env: { CATALYST_API_KEY: "private-key" },
      stdout: () => {},
      stderr: (text) => errors.push(text),
      fetchImpl: async () =>
        new Response("{}", { headers: { "catalyst-server-version": "999.0.0-rc.1" } })
    });
    expect(code).toBe(1);
    expect(errors.join("")).toContain("npm install --global @work-shape/catalyst-cli@999.0.0-rc.1");
  });

  it("accepts only the same release contract, ignoring build metadata", () => {
    expect(cliCompatibilityError(RELEASE_VERSION, `${RELEASE_VERSION}+build.1`)).toBeUndefined();
    expect(cliCompatibilityError("0.8.0-rc.1", "0.8.0-rc.2")).toBeInstanceOf(Error);
    expect(cliCompatibilityError("0.8.0", "0.8.1")).toBeInstanceOf(Error);
    expect(cliCompatibilityError("0.8.0", "not a version; secret")).toMatchObject({
      message: expect.not.stringContaining("secret")
    });
  });
});
