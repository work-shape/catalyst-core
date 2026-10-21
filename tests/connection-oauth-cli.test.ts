import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";

// CS-4b5, check 58 of connections-and-secrets.md: `catalyst connection connect` with a person's
// key completes only in that person's signed-in browser, prints the binding's state and never
// a token; a Service Principal's key is refused before a sign-in starts.

const keySchema = z.object({ secret: z.string() });
const printedSchema = z.object({
  connection: z.string(),
  binding: z.object({ state: z.string(), connectedAt: z.string() }).loose()
});

let world: OAuthWorld;
let cwd: string;

beforeAll(async () => {
  world = await createOAuthWorld();
  cwd = await mkdtemp(join(tmpdir(), "connection-oauth-cli-"));
}, 60_000);

afterAll(async () => {
  await world?.close();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** A personal key the person issues in Settings, for reading and writing config assets. */
async function personalKey(cookie: string): Promise<string> {
  const response = await fetch(`${world.api}/api/v1/me/api-keys`, {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({
      name: "Terminal",
      scopes: ["connection.read", "connection.write"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    })
  });
  const answer: unknown = await response.json();
  expect(response.status, JSON.stringify(answer)).toBe(200);
  return keySchema.parse(answer).secret;
}

async function cli(args: string[], key: string, options: CliRuntimeOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--instance", world.api], {
    cwd,
    env: { CATALYST_API_KEY: key },
    stdin: Readable.from([]),
    ...options,
    stdout: (text) => out.push(text),
    stderr: (text) => {
      err.push(text);
      options.stderr?.(text);
    }
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** The person's browser while the CLI waits: it signs in at the address the CLI opened. */
function browser(signIn: () => Promise<string>, opened: string[]) {
  return async () => {
    const [address] = opened;
    if (!address) throw new Error("Nothing was opened");
    const back = await world.authorize(address);
    return landingOf((await world.callback(back, { cookie: await signIn() })).location);
  };
}

describe("catalyst connection connect", () => {
  it("completes in another signed-in browser of the person, and prints the binding, never a token", async () => {
    const key = await personalKey(await world.signIn("alice"));
    const opened: string[] = [];
    const landings: Record<string, string>[] = [];
    const signsIn = browser(() => world.signIn("alice", "again"), opened);
    const result = await cli(["connection", "connect", "registered"], key, {
      openUrl: (address) => opened.push(address),
      sleep: async () => {
        if (landings.length > 0) throw new Error(`Not connected: ${JSON.stringify(landings)}`);
        landings.push(await signsIn());
      }
    });
    expect(result.code, result.err).toBe(0);
    expect(landings).toEqual([{ signIn: "connected", connection: "registered" }]);
    const printed = printedSchema.parse(JSON.parse(result.out));
    expect(printed).toMatchObject({ connection: "registered", binding: { state: "connected" } });
    // The address went to the browser and to standard error; nothing secret came back.
    expect(result.err).toContain(opened[0]);
    for (const secret of world.secrets) {
      expect(result.out + result.err).not.toContain(secret);
    }
    expect(result.out + result.err).not.toContain(key);

    const ended = await cli(["connection", "disconnect", "registered"], key);
    expect(ended.code, ended.err).toBe(0);
    expect(JSON.parse(ended.out)).toEqual({ state: "revoked", providerRevocation: "confirmed" });
  });

  it("does not complete in another person's browser, and keeps waiting", async () => {
    const key = await personalKey(await world.signIn("alice"));
    const opened: string[] = [];
    const landings: Record<string, string>[] = [];
    const signsIn = browser(() => world.signIn("bob"), opened);
    let printed = "";
    const result = await cli(["connection", "connect", "dcr", "--no-browser"], key, {
      openUrl: (address) => opened.push(`opened ${address}`),
      stderr: (text) => {
        printed += text;
      },
      sleep: async () => {
        // No browser was opened: the person copies the printed address.
        if (landings.length === 0) expect(opened).toEqual([]);
        if (landings.length === 0) opened.push(/^https?:\/\/\S+$/mu.exec(printed)?.[0] ?? "");
        if (landings.length > 0) throw new Error("Stopped waiting");
        landings.push(await signsIn());
      }
    });
    expect(landings).toEqual([{ signIn: "oauth_state_invalid" }]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("Stopped waiting");
  });

  it("refuses a Service Principal's key before anything starts", async () => {
    const principal = await world.instance.stores.apiAccess.createServicePrincipal({
      clientInstanceId: asClientInstanceId("demo-local"),
      displayLabel: "Automation",
      permissions: []
    });
    const credential = await world.instance.stores.apiAccess.createApiCredential({
      clientInstanceId: asClientInstanceId("demo-local"),
      servicePrincipalId: principal.id,
      name: "automation key",
      scopes: ["config_assets:read", "config_assets:write"]
    });
    const opened: string[] = [];
    const result = await cli(["connection", "connect", "dcr"], credential.secret, {
      openUrl: (address) => opened.push(address)
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("HTTP 403 FORBIDDEN");
    expect(opened).toEqual([]);
  });
});
