import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";
import {
  createInstanceInfrastructure,
  createWorkerCapabilityModels
} from "@work-shape/catalyst-client-assembly";
import {
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  asClientInstanceId,
  createEnvironmentSecretResolver,
  type ModelUsageEventStore
} from "@work-shape/catalyst-core";
import { replayServiceAccountKey } from "../support/model-adapter-recordings";
import { silentTestLogger } from "../support/model-gateway";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const INSTANCE = "https://catalyst.test";
const PROFILE = "arn:aws:bedrock:eu-central-1:000000000000:application-inference-profile/byo1test";
const PRICES = ["--input-price", "2.5", "--cached-input-price", "0.25", "--output-price", "10"];
/** A key value that must never reach a file or an output. */
const KEY_VALUE = "sk-live-4f9c2d7e1a8b-never-written";

/** The smallest release config a new deployment repository starts from: no model yet. */
const FRESH_CONFIG = `version: 1
clientInstance:
  id: byo-test
  displayName: Own Model Test
  environment: development
auth:
  development:
    enabled: true
`;

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "models-cli-"));
  directories.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function run(cwd: string, args: string[], options: CliRuntimeOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    cwd,
    env: { CATALYST_API_KEY: "test-cli-key", AZURE_OPENAI_API_KEY: KEY_VALUE },
    stdin: Readable.from([]),
    ...options,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** Startup creates the gateway in front of the usage ledger and records nothing. */
const unused = () => Promise.reject(new Error("The startup checks call no usage store"));
const unusedUsageStore: ModelUsageEventStore = {
  appendModelUsageEvent: unused,
  admitModelUsageEvent: unused,
  settleModelUsageEvent: unused,
  listPendingModelUsageEvents: unused,
  summarizeModelUsageHistory: unused,
  summarizeModelUsageBudget: unused,
  summarizeRecentModelUsage: unused,
  reconcileModelUsage: unused,
  readModelUsageMaintenance: unused,
  writeModelUsageMaintenance: unused,
  listModelUsageEvents: unused,
  clearUserFromModelUsageEvents: unused,
  clearWorkspaceFromModelUsageEvents: unused,
  backfillModelUsageAttribution: unused,
  readSpendLimits: unused,
  listSpendLimits: unused,
  setSpendLimit: unused,
  readSpendCounters: unused
};

/**
 * What startup does with a release config's models: it loads the file with what it extends,
 * validates every infrastructure entry against its adapter, creates each provider with its
 * secret and checks every binding's tool calls and price. It reaches no provider.
 */
async function startupAccepts(
  path: string,
  secrets: Record<string, string>
): Promise<ClientInstanceConfig> {
  const config = await loadClientInstanceConfigFromFile(path);
  const infrastructure = await createInstanceInfrastructure({
    config,
    env: {},
    logger: silentTestLogger,
    secrets: createEnvironmentSecretResolver({ env: secrets, readSecretFile: async () => "" })
  });
  await createWorkerCapabilityModels({
    config,
    clientInstanceId: asClientInstanceId(config.clientInstance.id),
    infrastructure,
    store: { usage: unusedUsageStore },
    bindingIds: config.modelBindings.map((binding) => binding.id)
  });
  return config;
}

async function filesUnder(root: string): Promise<string> {
  const texts: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) texts.push(await readFile(join(entry.parentPath, entry.name), "utf8"));
  }
  return texts.join("\n");
}

describe("catalyst models add", () => {
  const cases = [
    {
      kind: "azure",
      args: [
        "--endpoint",
        "https://byo-test.openai.azure.com/",
        "--model",
        "byo-gpt-deployment",
        "--label",
        "GPT Test"
      ],
      id: "azure-eu",
      secret: "AZURE_OPENAI_API_KEY",
      secretValue: KEY_VALUE,
      entry: {
        provider: "openai-compatible",
        region: "eu",
        api: "responses",
        model: "byo-gpt-deployment",
        baseUrl: "https://byo-test.openai.azure.com/openai/v1",
        authMode: "api-key",
        credentialSecret: "AZURE_OPENAI_API_KEY"
      },
      agentSelectable: true
    },
    {
      kind: "vertex",
      args: ["--project", "byo-test-project", "--model", "gemini-3.1-flash-lite"],
      id: "vertex-eu",
      secret: "GOOGLE_VERTEX_CREDENTIALS",
      secretValue: replayServiceAccountKey(),
      entry: {
        provider: "google-vertex",
        region: "eu",
        model: "gemini-3.1-flash-lite",
        projectId: "byo-test-project",
        credentialSecret: "GOOGLE_VERTEX_CREDENTIALS"
      },
      agentSelectable: false
    },
    {
      kind: "bedrock",
      args: ["--model", PROFILE, "--label", "Claude Sonnet 4.6"],
      id: "bedrock-eu",
      secret: "AWS_BEARER_TOKEN_BEDROCK",
      secretValue: "test-bedrock-key",
      entry: {
        provider: "aws-bedrock",
        region: "eu",
        accountId: "000000000000",
        model: PROFILE,
        credentialSecret: "AWS_BEARER_TOKEN_BEDROCK"
      },
      agentSelectable: true
    },
    {
      kind: "openai-compatible",
      args: [
        "--id",
        "byo-endpoint",
        "--base-url",
        "https://llm.example.test/v1",
        "--model",
        "byo-model",
        "--api",
        "chat_completions"
      ],
      id: "byo-endpoint",
      secret: "BYO_ENDPOINT_API_KEY",
      secretValue: "test-endpoint-key",
      entry: {
        provider: "openai-compatible",
        region: "eu",
        api: "chat_completions",
        model: "byo-model",
        baseUrl: "https://llm.example.test/v1",
        credentialSecret: "BYO_ENDPOINT_API_KEY"
      },
      agentSelectable: true
    }
  ] as const;

  it.each(cases)(
    "takes a new repository from no model to a config startup accepts with $kind, and names the one secret",
    async ({ kind, args, id, secret, secretValue, entry, agentSelectable }) => {
      const root = await repository({ "config/app.yaml": FRESH_CONFIG });
      const result = await run(root, ["models", "add", kind, ...args, ...PRICES]);
      expect(result, result.err).toMatchObject({ code: 0, err: "" });
      expect(result.out).toContain(`Added model provider '${id}' to config/app.yaml`);
      expect(result.out).toContain(`Set the secret ${secret} where the instance reads its secrets`);
      expect(result.out).toContain(`catalyst models check ${id} --instance <url>`);

      // Startup refuses the provider without its secret, and accepts it once the secret is set.
      await expect(startupAccepts(join(root, "config/app.yaml"), {})).rejects.toThrow(secret);
      const config = await startupAccepts(join(root, "config/app.yaml"), { [secret]: secretValue });
      expect(config.infrastructure.models[id]).toMatchObject(entry);
      expect(config.modelBindings).toEqual([
        expect.objectContaining({
          id,
          providerId: id,
          model: entry.model,
          ...(agentSelectable ? {} : { agentSelectable: false })
        })
      ]);
      expect(config.usage.costs.customer).toMatchObject({
        id: "byo-test",
        currency: "EUR",
        models: [
          {
            providerId: id,
            model: entry.model,
            uncachedInputPricePerMillionTokens: 2.5,
            cachedInputPricePerMillionTokens: 0.25,
            outputPricePerMillionTokens: 10
          }
        ]
      });
      expect(await filesUnder(root)).not.toContain(secretValue);
    }
  );

  it("adds after what is there and leaves every other line of the file as it was", async () => {
    const original = `version: 1
clientInstance:
  id: byo-test
  displayName: Own Model Test
  environment: development
auth:
  development:
    enabled: true
# The models the instance calls.
infrastructure:
  models:
    local:
      provider: deterministic
      # The local model answers without a provider.
  mail:
    provider: capture
    appUrl: http://127.0.0.1:5174
    sender: { fromAddress: noreply@example.test }

modelBindings:
  - id: primary
    providerId: local # every agent's default
usage:
  costs:
    customer:
      id: byo-card
      version: "2026-10"
      currency: EUR
      models: []
`;
    const root = await repository({ "config/app.yaml": original });
    const result = await run(root, [
      "models",
      "add",
      "azure",
      "--endpoint",
      "https://byo-test.openai.azure.com",
      "--model",
      "byo-gpt-deployment",
      "--binding",
      "byo-gpt",
      ...PRICES
    ]);
    expect(result, result.err).toMatchObject({ code: 0 });
    const written = await readFile(join(root, "config/app.yaml"), "utf8");
    // The empty list gives way to one written an item per line; nothing else that was there changes.
    const before = original.replace("      models: []\n", "      models:\n").split("\n");
    const after = written.split("\n");
    // Every line that was there is still there, in its order: the change only adds lines.
    let next = 0;
    for (const line of after) if (line === before[next]) next += 1;
    expect(next).toBe(before.length);
    expect(written).toContain(`    local:
      provider: deterministic
      # The local model answers without a provider.
    azure-eu:
      provider: openai-compatible`);
    expect(written).toContain(`    providerId: local # every agent's default
  - id: byo-gpt
    providerId: azure-eu`);
    expect(written).toContain(`      models:
        - providerId: azure-eu`);
    const config = await startupAccepts(join(root, "config/app.yaml"), {
      AZURE_OPENAI_API_KEY: "test"
    });
    // The first entry still serves an agent that names no provider.
    expect(Object.keys(config.infrastructure.models)).toEqual(["local", "azure-eu"]);
    expect(config.usage.costs.customer).toMatchObject({ id: "byo-card", version: "2026-10" });
  });

  it("writes into the shared base, says which environment replaces the list, and refuses an overlay that would replace it", async () => {
    const base = `version: 1
clientInstance:
  id: byo-test
  displayName: Own Model Test
auth:
  development:
    enabled: true
infrastructure:
  models:
    local:
      provider: deterministic
modelBindings:
  - id: primary
    providerId: local
`;
    const local = `extends: ./app.base.yaml
clientInstance:
  environment: development
modelBindings:
  - id: local-only
    providerId: local
`;
    const staging = `extends: ./app.base.yaml
clientInstance:
  environment: development
`;
    const root = await repository({
      "config/app.base.yaml": base,
      "config/app.local.yaml": local,
      "config/app.staging.yaml": staging
    });
    const args = [
      "models",
      "add",
      "bedrock",
      "--model",
      PROFILE,
      "--label",
      "Claude Sonnet 4.6",
      ...PRICES
    ];

    const refused = await run(root, [...args, "--config", "config/app.staging.yaml"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "config/app.staging.yaml takes 'modelBindings' from config/app.base.yaml; a list written here would replace that one. Add the provider to config/app.base.yaml with --config config/app.base.yaml. Nothing was written."
    );
    expect(await readFile(join(root, "config/app.staging.yaml"), "utf8")).toBe(staging);

    const added = await run(root, args);
    expect(added, added.err).toMatchObject({ code: 0 });
    expect(added.out).toContain("Added model provider 'bedrock-eu' to config/app.base.yaml");
    expect(added.out).toContain(
      "Note: config/app.local.yaml sets its own 'modelBindings', which replaces this one there: add the binding to it as well for that environment."
    );
    expect(await readFile(join(root, "config/app.local.yaml"), "utf8")).toBe(local);
    const config = await startupAccepts(join(root, "config/app.staging.yaml"), {
      AWS_BEARER_TOKEN_BEDROCK: "test-bedrock-key"
    });
    expect(config.modelBindings.map((binding) => binding.id)).toEqual(["primary", "bedrock-eu"]);
    expect(config.modelBindings[1]).toMatchObject({
      label: "Claude Sonnet 4.6",
      vendor: "anthropic"
    });
  });

  it("never asks for a key, never writes one, and never repeats one pasted where a name belongs", async () => {
    const root = await repository({ "config/app.yaml": FRESH_CONFIG });
    const questions: string[] = [];
    const answers = ["https://byo-test.openai.azure.com", "byo-gpt-deployment", "1", "0.1", "4"];
    const asked = await run(root, ["models", "add", "azure"], {
      prompt: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      }
    });
    expect(asked, asked.err).toMatchObject({ code: 0 });
    expect(questions).toEqual([
      "Endpoint of the Azure OpenAI resource (https://<resource>.openai.azure.com): ",
      "Name of the deployment on that resource: ",
      "Price of a million uncached input tokens in EUR: ",
      "Price of a million cached input tokens in EUR: ",
      "Price of a million output tokens in EUR: "
    ]);
    expect(asked.out).toContain("This command never asks for the key and never writes it.");
    // The key is in the environment the command runs in, and is in no file it wrote.
    expect(await filesUnder(root)).not.toContain(KEY_VALUE);

    const fresh = await repository({ "config/app.yaml": FRESH_CONFIG });
    for (const pasted of [KEY_VALUE, "AKIAIOSFODNN7EXAMPLE"]) {
      const refused = await run(fresh, [
        "models",
        "add",
        "azure",
        "--endpoint",
        "https://byo-test.openai.azure.com",
        "--model",
        "byo-gpt-deployment",
        "--secret",
        pasted,
        ...PRICES
      ]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        "--secret is refused: expected the name of an environment variable"
      );
      expect(refused.out + refused.err).not.toContain(pasted);
    }
    // A key passed where no option takes one is not repeated either.
    const stray = await run(fresh, ["models", "add", "azure", KEY_VALUE]);
    expect(stray.code).toBe(2);
    expect(stray.out + stray.err).not.toContain(KEY_VALUE);
    expect(await readFile(join(fresh, "config/app.yaml"), "utf8")).toBe(FRESH_CONFIG);
  });

  it("refuses a region outside the EU with the reason, and writes nothing", async () => {
    const root = await repository({ "config/app.yaml": FRESH_CONFIG });
    const region = await run(root, [
      "models",
      "add",
      "azure",
      "--region",
      "global",
      "--endpoint",
      "https://byo-test.openai.azure.com",
      "--model",
      "byo-gpt-deployment",
      ...PRICES
    ]);
    expect(region.code).toBe(1);
    expect(region.err).toContain(
      "--region must be 'eu': a provider added with this command processes data in the EU, and the endpoint must be deployed in an EU region."
    );
    const profile = await run(root, [
      "models",
      "add",
      "bedrock",
      "--model",
      PROFILE.replace("eu-central-1", "us-east-1"),
      "--label",
      "Claude",
      ...PRICES
    ]);
    expect(profile.code).toBe(1);
    expect(profile.err).toContain(
      "--model must be the ARN of an application inference profile in eu-central-1: the profile is in another region, and calls go to eu-central-1 only."
    );
    // The reason never repeats the ARN, which holds the account id.
    expect(profile.err).not.toContain("000000000000");
    const free = await run(root, [
      "models",
      "add",
      "bedrock",
      "--model",
      PROFILE,
      "--label",
      "Claude",
      "--input-price",
      "0",
      "--cached-input-price",
      "0.3",
      "--output-price",
      "15"
    ]);
    expect(free.code).toBe(1);
    expect(free.err).toContain("--input-price must be above zero");
    expect(await readFile(join(root, "config/app.yaml"), "utf8")).toBe(FRESH_CONFIG);
  });

  it("refuses an id that is taken and names what a command line leaves out", async () => {
    const root = await repository({ "config/app.yaml": FRESH_CONFIG });
    const args = [
      "models",
      "add",
      "vertex",
      "--project",
      "byo-test-project",
      "--model",
      "gemini-3.1-flash-lite",
      ...PRICES
    ];
    expect((await run(root, args)).code).toBe(0);
    const twice = await run(root, args);
    expect(twice).toMatchObject({ code: 1 });
    expect(twice.err).toContain(
      "The release config already has a model provider 'vertex-eu'. Choose another --id."
    );

    const missing = await run(root, ["models", "add", "openai-compatible", "--model", "byo-model"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain(
      "Missing --id, --base-url, --input-price, --cached-input-price, --output-price."
    );
    const elsewhere = await run(root, [
      "models",
      "add",
      "vertex",
      "--endpoint",
      "https://x.example.test"
    ]);
    expect(elsewhere).toMatchObject({ code: 2 });
    expect(elsewhere.err).toContain("--endpoint does not belong to 'catalyst models add vertex'.");
  });

  it("names a second key after its provider where the default name is taken", async () => {
    const root = await repository({ "config/app.yaml": FRESH_CONFIG });
    const azure = (id: string) => [
      "models",
      "add",
      "azure",
      "--id",
      id,
      "--endpoint",
      `https://${id}.openai.azure.com`,
      "--model",
      "byo-gpt-deployment",
      ...PRICES
    ];
    expect((await run(root, azure("azure-eu"))).code).toBe(0);
    const second = await run(root, azure("azure-sweden"));
    expect(second, second.err).toMatchObject({ code: 0 });
    expect(second.out).toContain("Set the secret AZURE_SWEDEN_API_KEY");
    const config = await startupAccepts(join(root, "config/app.yaml"), {
      AZURE_OPENAI_API_KEY: "first",
      AZURE_SWEDEN_API_KEY: "second"
    });
    expect(config.usage.costs.customer?.models.map((row) => row.providerId)).toEqual([
      "azure-eu",
      "azure-sweden"
    ]);
  });

  it("refuses an id that an environment file sets itself: the new keys would merge into its entry", async () => {
    const base = `${FRESH_CONFIG.replace("  environment: development\n", "")}infrastructure:
  models:
    local:
      provider: deterministic
`;
    const production = `extends: ./app.base.yaml
clientInstance:
  environment: development
infrastructure:
  models:
    azure-eu:
      provider: openai-compatible
      region: eu
      model: production-deployment
      baseUrl: https://production.example.test/v1
      credentialSecret: PRODUCTION_API_KEY
`;
    const root = await repository({
      "config/app.base.yaml": base,
      "config/app.production.yaml": production
    });
    const refused = await run(root, [
      "models",
      "add",
      "azure",
      "--endpoint",
      "https://byo-test.openai.azure.com",
      "--model",
      "byo-gpt-deployment",
      ...PRICES
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "config/app.production.yaml already sets a model provider 'azure-eu', and the entry written into config/app.base.yaml would merge into it. Choose another --id. Nothing was written."
    );
    expect(await readFile(join(root, "config/app.base.yaml"), "utf8")).toBe(base);
  });

  it("writes nothing where an added line would change what is there, such as a list an alias repeats", async () => {
    const original = `${FRESH_CONFIG}infrastructure:
  models:
    local:
      provider: deterministic
modelBindings: &bindings
  - id: primary
    providerId: local
x-bindings: *bindings
`;
    const root = await repository({ "config/app.yaml": original });
    const result = await run(root, [
      "models",
      "add",
      "vertex",
      "--project",
      "byo-test-project",
      "--model",
      "gemini-3.1-flash-lite",
      ...PRICES
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "The change could not be placed in config/app.yaml without touching what is there. Nothing was written."
    );
    expect(await readFile(join(root, "config/app.yaml"), "utf8")).toBe(original);
  });

  it("fills an empty list written on the line below its key", async () => {
    const root = await repository({ "config/app.yaml": `${FRESH_CONFIG}modelBindings:\n  []\n` });
    const result = await run(root, [
      "models",
      "add",
      "vertex",
      "--project",
      "byo-test-project",
      "--model",
      "gemini-3.1-flash-lite",
      ...PRICES
    ]);
    expect(result, result.err).toMatchObject({ code: 0 });
    const config = await startupAccepts(join(root, "config/app.yaml"), {
      GOOGLE_VERTEX_CREDENTIALS: replayServiceAccountKey()
    });
    expect(config.modelBindings.map((binding) => binding.id)).toEqual(["vertex-eu"]);
  });

  it("keeps a comment beside an empty key, with or without an empty value", async () => {
    for (const [empty, kept] of [
      ["modelBindings: # none yet", "modelBindings: # none yet"],
      ["modelBindings: [] # none yet", "modelBindings: # none yet"],
      ["modelBindings: ~", "modelBindings:"]
    ]) {
      const root = await repository({ "config/app.yaml": `${FRESH_CONFIG}${empty}\nusage: {}\n` });
      const result = await run(root, [
        "models",
        "add",
        "vertex",
        "--project",
        "byo-test-project",
        "--model",
        "gemini-3.1-flash-lite",
        ...PRICES
      ]);
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(await readFile(join(root, "config/app.yaml"), "utf8")).toContain(
        `${kept}\n  - id: vertex-eu\n`
      );
      const config = await startupAccepts(join(root, "config/app.yaml"), {
        GOOGLE_VERTEX_CREDENTIALS: replayServiceAccountKey()
      });
      expect(config.modelBindings.map((binding) => binding.id)).toEqual(["vertex-eu"]);
    }
  });
});

function apiFetch(answer: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === apiOperations["access_tokens.exchange"].path) {
      return Response.json({
        accessToken: "test-access-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    return answer(request);
  };
}

const CHECKED_AT = "2026-10-24T12:00:00.000Z";

function infrastructure(check: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: "models.azure-eu",
        class: "models",
        name: "azure-eu",
        type: "openai-compatible",
        origin: "operator",
        external: true,
        region: "eu",
        endpointHost: "byo-test.openai.azure.com",
        secrets: [{ name: "AZURE_OPENAI_API_KEY", state: "set" }],
        check,
        ...extra
      },
      {
        id: "database",
        class: "database",
        type: "postgres",
        origin: "operator",
        external: false,
        secrets: [],
        check: { status: "ok", checkedAt: CHECKED_AT }
      }
    ],
    checkIntervalSeconds: 300
  };
}

describe("catalyst models check", () => {
  it("runs the instance's check where the key is, and prints ok with what the check shows", async () => {
    const root = await repository({});
    const received: Request[] = [];
    const result = await run(root, ["models", "check", "azure-eu", "--instance", INSTANCE], {
      fetchImpl: apiFetch((request) => {
        received.push(request);
        return Response.json(infrastructure({ status: "ok", checkedAt: CHECKED_AT }));
      })
    });
    expect(result, result.err).toMatchObject({ code: 0, err: "" });
    expect(result.out).toBe(
      "ok  models.azure-eu  openai-compatible, region eu, byo-test.openai.azure.com\n" +
        "  secret AZURE_OPENAI_API_KEY: set\n" +
        "  The check listed the models of the resource with the key. It does not call the deployment.\n"
    );
    const check = apiOperations["instance.infrastructure.check"];
    expect(
      received.map((request) => [
        request.method,
        new URL(request.url).pathname,
        request.headers.get("authorization")
      ])
    ).toEqual([[check.method, check.path, "Bearer test-access-token"]]);
  });

  it("prints the class of a failure in the product's words and nothing a provider said", async () => {
    const root = await repository({});
    const providerText = "Incorrect API key provided: sk-proj-1234. You can find your API key at";
    const fetchImpl = apiFetch(() =>
      Response.json(
        infrastructure(
          {
            status: "failed",
            checkedAt: CHECKED_AT,
            errorClass: "access_denied",
            message: providerText
          },
          {
            secrets: [{ field: "credentialSecret", state: "missing" }],
            providerMessage: providerText
          }
        )
      )
    );
    for (const json of [[], ["--json"]]) {
      const result = await run(
        root,
        ["models", "check", "azure-eu", "--instance", INSTANCE, ...json],
        { fetchImpl }
      );
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain("Incorrect API key");
      expect(result.out + result.err).not.toContain("sk-proj");
      if (json.length === 0) {
        expect(result.out).toContain("failed  models.azure-eu");
        expect(result.out).toContain("  secret credentialSecret: missing\n");
        expect(result.out).toContain("  access_denied: The provider refused the credentials.\n");
      } else {
        expect(JSON.parse(result.out)).toMatchObject({
          id: "models.azure-eu",
          check: { status: "failed", errorClass: "access_denied" }
        });
      }
    }
  });

  it("names the providers the instance has, never repeats an id it does not, and passes on the instance's refusal", async () => {
    const root = await repository({});
    // A key pasted where the id belongs is not a provider of the instance, and is not repeated.
    for (const id of ["bedrock-eu", KEY_VALUE]) {
      const absent = await run(root, ["models", "check", id, "--instance", INSTANCE], {
        fetchImpl: apiFetch(() => Response.json(infrastructure({ status: "pending" })))
      });
      expect(absent.code).toBe(1);
      expect(absent.err).toContain(
        "The instance has no model provider by that id (it has azure-eu). Deploy the release config that adds it, then check again."
      );
      expect(absent.out + absent.err).not.toContain(id);
    }
    const refused = await run(root, ["models", "check", "azure-eu", "--instance", INSTANCE], {
      fetchImpl: apiFetch(() =>
        Response.json(
          { error: { code: "FORBIDDEN", message: "This needs the right users.manage." } },
          { status: 403 }
        )
      )
    });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("users.manage");
  });
});

describe("catalyst models list", () => {
  it("lists the providers of the release config, and with --instance what the instance reports", async () => {
    const root = await repository({ "config/app.yaml": FRESH_CONFIG });
    await run(root, [
      "models",
      "add",
      "azure",
      "--endpoint",
      "https://byo-test.openai.azure.com",
      "--model",
      "byo-gpt-deployment",
      ...PRICES
    ]);
    await run(root, [
      "models",
      "add",
      "bedrock",
      "--model",
      PROFILE,
      "--label",
      "Claude Sonnet 4.6",
      ...PRICES
    ]);
    const local = await run(root, ["models", "list"], {
      fetchImpl: () => {
        throw new Error("A local list must not call an instance");
      }
    });
    expect(local, local.err).toMatchObject({ code: 0 });
    expect(local.out).toBe(
      "Model providers of config/app.yaml:\n" +
        "  azure-eu  openai-compatible, region eu, secret AZURE_OPENAI_API_KEY, bindings: azure-eu\n" +
        "  bedrock-eu  aws-bedrock, region eu, secret AWS_BEARER_TOKEN_BEDROCK, bindings: bedrock-eu\n"
    );
    const remote = await run(root, ["models", "list", "--instance", INSTANCE, "--json"], {
      fetchImpl: apiFetch((request) => {
        expect(new URL(request.url).pathname).toBe(
          apiOperations["instance.infrastructure.get"].path
        );
        return Response.json(infrastructure({ status: "ok", checkedAt: CHECKED_AT }));
      })
    });
    expect(remote, remote.err).toMatchObject({ code: 0 });
    expect(JSON.parse(remote.out)).toMatchObject({
      config: "config/app.yaml",
      providers: [
        { id: "azure-eu", priced: true, instance: { check: { status: "ok" } } },
        { id: "bedrock-eu", priced: true, instance: "absent" }
      ]
    });
  });
});
