import {
  createTestAssetKinds,
  createTestFetch,
  createTestInstance,
  type TestInstance
} from "./test-instance";
import { testOperations } from "./operations";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inject, afterEach } from "vitest";
import { z } from "zod";
import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter
} from "@work-shape/catalyst-auth";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  asUserId,
  createAssetKindRegistry,
  type AgentRuntime,
  type JsonObject,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  createScriptedInstanceModelGateway,
  type FakeModelProvider as ModelProvider
} from "./model-gateway";
import {
  GuardrailRunner,
  createAuditingEventEmitter,
  createGuardrailAssetKind
} from "@work-shape/catalyst-server";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import {
  STATE_FILENAME,
  CANONICAL_FORM_VERSION,
  canonicalizeAgentConfig,
  canonicalizeSkillConfig,
  runCli,
  commandNames,
  serializeAgentYaml,
  writeStateFile
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "./asset-revisions";
import {
  agentConfig as personalAgentConfig,
  inDays,
  type PersonalKeyInstance
} from "./personal-api-keys";

const servers: TestInstance[] = [];

export const temporaryDirectories: string[] = [];

const httpServers: Server[] = [];
export function registerConfigCliHooks() {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });
  afterEach(async () => {
    await Promise.all(
      httpServers
        .splice(0)
        .map((server) => new Promise((done) => server.close(() => done(undefined))))
    );
  });
}

if (!inject("sharedPostgresHooks")) registerConfigCliHooks();

/** A working copy bound to one workspace, with one agent. */
export async function kaiWorkingCopy(
  workspaceId = "cws_kai",
  agentName = "kai-tax"
): Promise<string> {
  const directory = await createTemporaryDirectory();
  await writeFile(
    join(directory, "catalyst.yaml"),
    `instances:\n  production:\n    url: https://catalyst.test\n    workspace: ${workspaceId}\ndefaultInstance: production\nagents:\n  - agents/*.agent.yaml\nskills:\n  - skills/*/SKILL.md\n`
  );
  await mkdir(join(directory, "agents"));
  await writeFile(
    join(directory, "agents", `${agentName}.agent.yaml`),
    serializeAgentYaml(personalAgentConfig(agentName))
  );
  return directory;
}

/** What `show --json` prints of an asset: the definition under `config`, beside its facts. */
export const shownAnswerSchema = z
  .object({ kind: z.string(), revision: z.number(), config: z.record(z.string(), z.unknown()) })
  .loose();

/** A real HTTP server on this machine, so that a redirect is one the runtime would follow. */
export async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
    handler(request, response);
  });
  httpServers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server has no port");
  }
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

export function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

export async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "catalyst-config-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * An instance behind the CLI. `guardrails` are its release config's, run at every call. With
 * `guardrailKind` it also holds guardrails as assets.
 */
export async function createFixture(
  guardrails: Record<string, unknown> = {},
  guardrailKind = false,
  /** The module a writer who is no release needs, such as a CLI root bound to a workspace. */
  assetManagement = false
) {
  const clientInstanceId = asClientInstanceId("config-cli-test");
  const store = (await createTestInstance()).stores;
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Config CLI test",
      environment: "development"
    },
    auth: {},
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
    tools: [{ name: "known.tool", enabled: true }],
    guardrails,
    // A push writes guardrails one by one with `assets.put`, which the module switches, and so
    // does every write of a root bound to a workspace.
    ...(guardrailKind || assetManagement ? { modules: { assetManagement: { enabled: true } } } : {})
  });
  if (assetManagement) {
    config.administration.agentConfiguration.allowAgentCreation = true;
    config.administration.agentConfiguration.allowSkillEditing = true;
    config.administration.agentConfiguration.editableAgentFields = [
      "displayName",
      "description",
      "instructions",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ];
  }
  const authOptions = {
    secret: "a-development-session-token-secret",
    clientInstanceId,
    issuer: "config-cli-test",
    ttlSeconds: 900
  };
  const issuer = new HmacSessionTokenIssuer(authOptions);
  const serviceAccessOptions = {
    secret: "a-development-service-access-secret-with-enough-length",
    clientInstanceId,
    apiAccessStore: store.apiAccess
  };
  const servicePrincipal = await store.apiAccess.createServicePrincipal({
    clientInstanceId,
    displayLabel: "Catalyst CLI",
    permissions: [
      "config_assets.read",
      "config_assets.release",
      ...(guardrailKind ? ["config_assets.write"] : [])
    ]
  });
  const createdCredential = await store.apiAccess.createApiCredential({
    clientInstanceId,
    servicePrincipalId: servicePrincipal.id,
    name: "config CLI test",
    // A guardrail is written with `assets.put`, which a credential reaches with the write scope.
    scopes: [
      "config_assets:read",
      "config_assets:release",
      ...(guardrailKind ? ["config_assets:write"] : [])
    ]
  });
  // No legacy key carries a right on guardrails: the CLI's key is granted them as rows.
  for (const action of guardrailKind ? ["guardrail.read", "guardrail.write"] : []) {
    await store.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: servicePrincipal.id,
      action,
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId("usr_config_cli_test")
    });
  }
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit });
  const usageGovernance = new ModelUsageGovernance({
    store: store.usage,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    costs: config.usage.costs
  });
  const guardrailRunner = new GuardrailRunner({
    clientInstanceId,
    config,
    hits: store.guardrails,
    modelGateway: createScriptedInstanceModelGateway({
      config,
      modelProvider: createUnusedModelProvider(),
      usageGovernance
    })
  });
  const server = await createTestInstance({
    server: {
      config,
      clientInstanceId,
      operations: { events: createAuditingEventEmitter(auditRecorder, guardrailRunner) },
      authAdapter: new IdentityResolvingAuthAdapter(
        new CompositeAuthAdapter([
          new HmacServiceAccessTokenAuthAdapter(serviceAccessOptions),
          new HmacSessionTokenAuthAdapter(authOptions)
        ]),
        store.users
      ),
      stores: store,
      usageGovernance,
      auditRecorder,
      configAssets: {
        store: store.configAssets,
        validationRefs: fixtureValidationRefs,
        ...(guardrailKind
          ? {
              kinds: createAssetKindRegistry([
                ...createTestAssetKinds({ config, validationRefs: fixtureValidationRefs }).kinds,
                createGuardrailAssetKind()
              ])
            }
          : {})
      },
      agentRuntime: createUnusedAgentRuntime(),
      modelProvider: createUnusedModelProvider(),
      sessionToken: { issuer, serverCredential: "server-credential" },
      serviceAccessToken: {
        exchange: new ApiKeyAccessTokenExchange(serviceAccessOptions)
      }
    }
  });
  servers.push(server);
  return { clientInstanceId, server, store, apiKey: createdCredential.secret };
}

/** The validation refs of the fixture's instance, also for a registry made beside it. */
const fixtureValidationRefs = {
  modelProviderIds: ["local"],
  modelBindingIds: [],
  modelBindings: [],
  fastModeModelBindingIds: [],
  reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
  enabledToolNames: ["known.tool", "read_skill"]
};

export async function writeMinimalManifest(
  directory: string,
  url: string,
  defaultAgentName?: string
): Promise<void> {
  const defaultAgent =
    defaultAgentName === undefined ? "" : `defaultAgentName: ${defaultAgentName}\n`;
  await writeFile(
    resolve(directory, "catalyst.yaml"),
    `instances:\n  local:\n    url: ${url}\ndefaultInstance: local\n${defaultAgent}agents:\n  - agents/*.agent.yaml\nskills:\n  - skills/*/SKILL.md\n`,
    "utf8"
  );
}

/** A credentials file as `catalyst login` writes it, with one key for each origin. */
export async function saveCredentialsFor(configHome: string, origins: string[]): Promise<void> {
  const key = (origin: string) => ({
    apiKey: `cat.apic_test_${new URL(origin).hostname}`,
    keyId: `key_${new URL(origin).hostname}`,
    name: "Test key",
    expiresAt: inDays(30),
    savedAt: new Date().toISOString()
  });
  const file = { version: 1, instances: Object.fromEntries(origins.map((o) => [o, key(o)])) };
  await writeFile(join(configHome, "credentials.json"), JSON.stringify(file), { mode: 0o600 });
}

export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** The state a pull of an instance without assets leaves in the working copy. */
export async function recordEmptyPull(directory: string): Promise<void> {
  await writeStateFile(resolve(directory, STATE_FILENAME), {
    instances: { local: { lastPulledVersion: 0, assets: {}, defaultAgentName: null } }
  });
}

export function pulledBaseline(
  version: number,
  bundle: { defaultAgentName?: string; agents: unknown[]; skills: unknown[] }
) {
  const contents = [
    ...bundle.agents.map((asset) => {
      const agent = canonicalizeAgentConfig(asset);
      return { key: `agent:${agent.name}`, contents: serializeAgentYaml(agent) };
    }),
    ...bundle.skills.map((asset) => {
      const skill = canonicalizeSkillConfig(asset);
      return {
        key: `skill:${skill.name}`,
        contents: JSON.stringify({ ...skill, content: skill.content.trim() })
      };
    })
  ];
  return {
    lastPulledVersion: version,
    defaultAgentName: bundle.defaultAgentName ?? null,
    assets: Object.fromEntries(
      contents.map((asset) => [
        asset.key,
        {
          id: heldAssetId(asset.key),
          canonicalFormVersion: CANONICAL_FORM_VERSION,
          revision: 1,
          hash: createHash("sha256").update(asset.contents).digest("hex"),
          // A pull of this CLI saw no agent draft.
          ...(asset.key.startsWith("agent:") ? { draftRevision: null } : {})
        }
      ])
    )
  };
}

/** The id `instanceHolding` gives an asset, so a baseline written by hand names the same one. */
export function heldAssetId(key: string): string {
  return `cfga_held_${key.replace(":", "_")}`;
}

interface HeldAssets {
  defaultAgentName?: string;
  agents: ReadonlyArray<JsonObject & { name: string }>;
  skills: ReadonlyArray<JsonObject & { name: string }>;
  /** Given, the instance holds guardrails as assets, these among them. */
  guardrails?: ReadonlyArray<JsonObject & { name: string }>;
}

/**
 * A real instance that holds these assets, each at revision 1, behind a fetch for the CLI.
 * The fetch signs in with the instance's key whatever key the command names, and records
 * the body of every `assets.sync` the CLI sends.
 */
export async function instanceHolding(
  remote: HeldAssets,
  syncs: unknown[] = [],
  /** The id each asset gets. Another one makes the instance another database's. */
  idOf: (key: string) => string = heldAssetId,
  guardrails: Record<string, unknown> = {},
  assetManagement = false
) {
  const fixture = await createFixture(guardrails, remote.guardrails !== undefined, assetManagement);
  const mutations = [
    ...remote.agents.map((config) => ({
      type: "upsert" as const,
      kind: "agent",
      name: config.name,
      assetId: idOf(`agent:${config.name}`),
      config
    })),
    ...remote.skills.map((config) => ({
      type: "upsert" as const,
      kind: "skill",
      name: config.name,
      assetId: idOf(`skill:${config.name}`),
      config
    })),
    ...(remote.guardrails ?? []).map((config) => ({
      type: "upsert" as const,
      kind: "guardrail",
      name: config.name,
      assetId: idOf(`guardrail:${config.name}`),
      config
    })),
    ...(remote.defaultAgentName === undefined
      ? []
      : [{ type: "setDefaultAgent" as const, agentName: remote.defaultAgentName }])
  ];
  if (mutations.length > 0) {
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations
    });
  }
  const serverFetch = createTestFetch(fixture.server);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === testOperations["access_tokens.exchange"].path) {
      return serverFetch(request.url, {
        method: request.method,
        headers: { authorization: `Bearer ${fixture.apiKey}` }
      });
    }
    if (path === testOperations["assets.sync"].path) {
      syncs.push(JSON.parse(await request.clone().text()));
    }
    return serverFetch(request);
  };
  return { fetchImpl, fixture };
}

/** An instance without assets, reached under another address. The addresses are recorded. */
export async function emptyInstanceBehind(
  baseUrl: string,
  requests: string[]
): Promise<typeof fetch> {
  const { fetchImpl } = await instanceHolding({ agents: [], skills: [] });
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.url);
    const body = request.body ? await request.clone().text() : undefined;
    return fetchImpl(`https://catalyst.test${request.url.slice(baseUrl.length)}`, {
      method: request.method,
      headers: request.headers,
      ...(body === undefined ? {} : { body })
    });
  };
}

export function recordFetch(
  fetchImpl: typeof fetch,
  requests: Array<{ url: string; init?: RequestInit }>
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: request.url,
      init: {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: await request.clone().text() })
      }
    });
    return fetchImpl(input, init);
  };
}

export function agentConfig(instructions: string, overrides: { name?: string } = {}) {
  return {
    name: overrides.name ?? "assistant",
    displayName: "Assistant",
    instructions,
    modelProviderId: "local",
    toolNames: [],
    skillNames: [],
    initialPrompts: []
  };
}

export function skillConfig(name: string, content: string) {
  return {
    name,
    title: name,
    description: `${name} skill`,
    content: `# ${content}`
  };
}

function createUnusedAgentRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async *observe() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async getStatus() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async resume() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async cancel() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by config CLI tests");
    }
  };
}

// `catalyst setup <tool> --instance <url>` connects a local agent in one step: a connect code
// the person confirms in Settings where no working key is saved, then the Catalyst skill where
// the tool reads skills. Platform Access acceptance check 53 (CONNECT-1a).

export const SETUP_INSTANCE = "https://catalyst.test";

export const keysSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() }).loose())
});

/** One person's computer: a home folder, a CLI config folder, and the CLI as it runs there. */
export async function computerOf(t: PersonalKeyInstance) {
  const home = await createTemporaryDirectory();
  const env = { HOME: home, CATALYST_CONFIG_HOME: join(home, ".config", "catalyst") };
  const paths: string[] = [];
  const instanceFetch = createTestFetch(t.instance);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    paths.push(new URL(request.url).pathname);
    return instanceFetch(request);
  };
  const opened: string[] = [];

  /** Runs setup; the person confirms the code it shows as Settings would, with its label as the name. */
  async function setup(args: string[], moreEnv: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let confirmed = false;
    const sleep = async () => {
      if (confirmed) return;
      const userCode = /code ([A-Z]{4}-[A-Z]{4})/u.exec(out.join(""))?.[1] ?? "";
      const asking = await t.expectOk(t.kai.id, "me.connect_codes.get", {
        params: { userCode }
      });
      const clientLabel = z.object({ clientLabel: z.string() }).parse(asking.json()).clientLabel;
      await t.expectOk(t.kai.id, "me.connect_codes.confirm", {
        params: { userCode },
        payload: {
          name: clientLabel,
          scopes: [`agent.read:${t.kaiTeam}`],
          expiresAt: inDays(30)
        }
      });
      confirmed = true;
    };
    const code = await runCli(["setup", ...args], {
      env: { ...env, ...moreEnv },
      fetchImpl,
      sleep,
      openUrl: (address) => opened.push(address),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text)
    });
    return { code, out: out.join(""), err: err.join("") };
  }

  return { home, env, paths, opened, setup };
}

export async function savedKey(configHome: string): Promise<string> {
  const saved = await readFile(join(configHome, "credentials.json"), "utf8");
  const key = /cat\.apic_[^"]+/u.exec(saved)?.[0];
  if (!key) throw new Error("No key was saved");
  return key;
}

/** The mark of a skill `catalyst setup` wrote, for this text before the mark. */
export function sha256Mark(rendered: string): string {
  const body = rendered.slice(0, rendered.lastIndexOf("\n<!-- Written by catalyst setup"));
  return `sha256 ${createHash("sha256").update(body).digest("hex")}`;
}

/**
 * The commands and options a skill names that `catalyst --help` does not list. A command is a
 * line of a code block or a code span that starts with `catalyst`; an option is any `--word`
 * of the skill.
 */
export function unlistedInHelp(skill: string, help: string): string[] {
  const listed = (word: string) =>
    new RegExp(`(?:^|\\n)\\s+${word}\\s|catalyst ${word}\\b|<kind> ${word}\\b`, "u").test(help);
  const commands = [
    ...[...skill.matchAll(/```sh\n([\s\S]*?)```/gu)].flatMap((block) =>
      (block[1] ?? "").split("\n")
    ),
    ...[...skill.matchAll(/`([^`\n]+)`/gu)].map((span) => span[1] ?? "")
  ].filter((line) => line.startsWith("catalyst "));
  const problems: string[] = [];
  for (const command of commands) {
    const [, first = "", second = ""] = command.split(/\s+/u);
    if (first.startsWith("-")) continue;
    const names = commandNames();
    const words = command.split(/\s+/u).slice(1);
    const registered = names.some((name) =>
      name.split(" ").every((word, index) => word === "<kind>" || word === words[index])
    );
    if (registered && (listed(first) || listed(second) || listed(`${first} ${second}`))) continue;
    if (first === "config") {
      problems.push(`command 'config ${second}' in: ${command}`);
    } else if (second === "" || second.startsWith("-")) {
      problems.push(`command '${first}' in: ${command}`);
    } else {
      problems.push(`'${first} ${second}' in: ${command}`);
    }
  }
  for (const [option] of skill.matchAll(/--[a-z][a-z-]*/gu)) {
    if (!help.includes(option)) problems.push(`option '${option}'`);
  }
  return [...new Set(problems)];
}
