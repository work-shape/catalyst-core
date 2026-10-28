import { describe, expect, it } from "vitest";
import { RELEASE_VERSION } from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import {
  createTemporaryDirectory,
  instanceHolding,
  saveCredentialsFor
} from "../support/config-cli";
import { testOperations } from "../support/operations";

const instance = "https://instance.test";
const secret = "cat_doctor_key_must_stay_private";

async function run(
  fetchImpl: typeof fetch,
  env: Record<string, string> = { CATALYST_API_KEY: secret },
  args = ["doctor", "--instance", instance]
) {
  const out: string[] = [],
    err: string[] = [];
  const code = await runCli(args, {
    cwd: await createTemporaryDirectory(),
    env,
    fetchImpl,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  });
  return { code, out: out.join(""), err: err.join("") };
}

const health = () =>
  Response.json(
    { status: "ok", clientInstanceId: "private-instance-id", time: new Date().toISOString() },
    { headers: { "catalyst-server-version": RELEASE_VERSION } }
  );

describe("catalyst doctor", () => {
  it("checks a real instance and prints four green lines without keys, tokens or identities", async () => {
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [] });
    const result = await run(async (input, init) => {
      const response = await fetchImpl(input, init);
      expect(response.headers.get("catalyst-server-version")).toBe(RELEASE_VERSION);
      return response;
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out.split("\n").filter(Boolean)).toEqual([
      `OK Address: ${instance}/`,
      "OK Sign-in: API key accepted",
      `OK Versions: CLI ${RELEASE_VERSION}; server ${RELEASE_VERSION}`,
      expect.stringMatching(
        /^OK Key rights: \d+ instance actions, \d+ scoped asset actions, \d+ workspace actions$/u
      )
    ]);
    expect(result.out).not.toContain(secret);
    expect(result.out).not.toContain("config-cli-test");
  });

  it("uses the sole saved instance outside a working copy", async () => {
    const configHome = await createTemporaryDirectory();
    await saveCredentialsFor(configHome, [instance]);
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [] });
    const result = await run(fetchImpl, { CATALYST_CONFIG_HOME: configHome }, ["doctor"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`OK Address: ${instance}/`);
    expect(result.out).not.toContain("cat.apic_");
  });

  it.each(["text/html", "application/json"])(
    "identifies a wrong address returning %s without its contents",
    async (type) => {
      const body =
        type === "text/html" ? `<html>${secret}</html>` : JSON.stringify({ private: secret });
      const result = await run(async (_input, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(init?.redirect).toBe("manual");
        return new Response(body, { headers: { "content-type": type } });
      });
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        `${instance}/health returned ${type === "text/html" ? "an HTML page" : "other JSON"}`
      );
      expect(result.out).toContain("SKIP Sign-in");
      expect(result.out).not.toContain(secret);
    }
  );

  it("reports a missing key after checking the address and versions", async () => {
    const result = await run(async () => health(), {
      CATALYST_CONFIG_HOME: await createTemporaryDirectory()
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("OK Address:");
    expect(result.out).toContain("FAIL Sign-in: no working key");
    expect(result.out).toContain("OK Versions:");
    expect(result.out).toContain("SKIP Key rights:");
  });

  it("reports an expired or refused key without printing the refusal body", async () => {
    const result = await run(async (input) =>
      String(input).endsWith("/health")
        ? health()
        : Response.json({ error: { code: "UNAUTHENTICATED", message: secret } }, { status: 401 })
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL Sign-in:");
    expect(result.out).not.toContain(secret);
  });

  it("reports a version mismatch before sending a key", async () => {
    const result = await run(async (_input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      const response = health();
      response.headers.set("catalyst-server-version", "0.7.0");
      return response;
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("OK Address:");
    expect(result.out).toContain("FAIL Versions:");
    expect(result.out).toContain("npm install --global @work-shape/catalyst-cli@0.7.0");
    expect(result.out).toContain("SKIP Sign-in: update the CLI first");
  });

  it("reports a key with no effective rights instead of inferring rights from issuance choices", async () => {
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [] });
    const result = await run(async (input, init) => {
      const response = await fetchImpl(input, init);
      if (new URL(String(input)).pathname !== testOperations["platform.context.get"].path)
        return response;
      const context = await response.json();
      return Response.json({
        ...context,
        actions: [],
        instanceActions: [],
        assetActions: [],
        workspaces: [],
        authoringActions: ["agent.write"],
        useActions: ["agent.use"]
      });
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("OK Sign-in:");
    expect(result.out).toContain("FAIL Key rights: no effective actions");
  });

  it("reports an unreachable instance and stays within four shareable lines", async () => {
    const result = await run(async () => {
      throw new Error(secret);
    });
    expect(result.code).toBe(1);
    expect(result.out.split("\n").filter(Boolean)).toHaveLength(4);
    expect(result.out).toContain("FAIL Address:");
    expect(result.out).not.toContain(secret);
  });
});
