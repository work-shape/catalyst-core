import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { createApiClient, listAll, signInForSessionFetch } from "@vivd-catalyst/api-client";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { checkAsset, checkedAssetId } from "@vivd-catalyst/chat-ui/access";
import {
  SEED_EMAIL_SUFFIX,
  checkQuestions,
  demoOperations,
  demoTools,
  people,
  seedDemo,
  type CheckReason,
  type SeedReport
} from "@vivd-catalyst/demo/seed";
import { createTestInstance, getTestRuntime } from "./test-instance";

// What the tests of `pnpm demo:seed` share: an instance of the demo's assembly on a config
// of the test's choice, seeded twice, and what the seed left on it after each run.

interface SeededInstanceInput {
  /** The client instance config the instance runs on and the seed reads its superadmin from. */
  configPath: string;
  /** The address the config's own manifest names. Nothing listens there: calls stay in process. */
  baseUrl: string;
  /** An origin the config trusts. */
  origin: string;
  /** The instance's own config working copy, the one its default agent comes from. */
  instanceAssets: string;
  /** The development superadmin of the config. */
  superadmin: { email: string; password: string };
  /** Tools the config enables beside the demo's own. */
  tools?: ToolAssemblyDefinition[];
  env?: Record<string, string>;
}

type InstanceState = Awaited<ReturnType<typeof readInstance>>;

interface SeededInstance {
  first: SeedReport;
  second: SeedReport;
  /** The instance after the first run and after the second. */
  before: InstanceState;
  after: InstanceState;
  /** The working copies the runs pushed, for a further call of the seed. */
  assetsDir: string;
  instanceAssetsDir: string;
  envFile: string;
}

/** What the seed leaves on the instance, read back through the product's own operations. */
async function readInstance(input: SeededInstanceInput, fetchImpl: typeof fetch) {
  const client = createApiClient({
    baseUrl: input.baseUrl,
    fetchImpl: await signInForSessionFetch({
      apiBaseUrl: input.baseUrl,
      origin: input.origin,
      ...input.superadmin,
      fetchImpl
    })
  });
  const [users, namespaces, grants, principals, overview, approvals] = await Promise.all([
    listAll((paging) => client.users.list({ query: paging })),
    listAll((paging) => client.namespaces.list({ query: paging })),
    listAll((paging) => client.permissions.list({ query: paging })),
    listAll((paging) => client.service_principals.list({ query: paging })),
    client.config_assets.get_overview(),
    listAll((paging) => client.approval_requests.list({ query: { ...paging, status: "pending" } }))
  ]);
  return {
    client,
    users: users
      .filter((user) => user.email?.endsWith(SEED_EMAIL_SUFFIX))
      // A sign-in moves both times, and three of the people sign in on every run.
      .map(({ lastAuthenticatedAt, updatedAt: _touchedAt, identities, ...user }) => ({
        ...user,
        identities: identities.length,
        signedIn: lastAuthenticatedAt !== undefined
      })),
    namespaces,
    grants,
    principals: principals.map(({ principal, credentials }) => ({
      id: principal.id,
      displayLabel: principal.displayLabel,
      credentials: credentials.map((credential) => credential.id)
    })),
    assets: overview.assets.map(({ kind, name, revision, availability, id }) => ({
      kind,
      name,
      revision,
      id,
      shown: availability?.mode
    })),
    assetSummaries: overview.assets,
    defaultAgentName: overview.defaultAgentName,
    approvals: approvals.map((request) => ({
      id: request.id,
      kind: request.kind,
      requestedBy: request.requestedBy.displayLabel,
      status: request.status
    }))
  };
}

/**
 * Starts the instance before the tests of the file and runs the seed twice. The returned
 * function answers in a test, once that is done.
 */
export function useSeededInstance(input: SeededInstanceInput): () => SeededInstance {
  let seeded: SeededInstance | undefined;
  let directory: string | undefined;

  beforeAll(async () => {
    const instance = await createTestInstance({
      configPath: input.configPath,
      tools: [...demoTools, ...(input.tools ?? [])],
      // The demo's own server runs with these.
      operations: demoOperations,
      seedAssets: false,
      env: {
        CHAT_UI_ORIGIN: input.origin,
        BETTER_AUTH_URL: `${input.baseUrl}/api/auth`,
        BETTER_AUTH_SECRET: "seed-test-better-auth-secret-with-32-characters",
        CHAT_SESSION_TOKEN_SECRET: "seed-test-session-token-secret-24-chars",
        CHAT_SERVER_CREDENTIAL: "seed-test-server-credential",
        SERVICE_ACCESS_TOKEN_SECRET: "seed-test-service-access-token-secret-32-chars",
        ...input.env
      }
    });
    const runtime = await getTestRuntime(instance);
    const fetchImpl: typeof fetch = (resource, init) => runtime.fetch(new Request(resource, init));

    // A push records its baseline beside the working copy, so the test pushes copies.
    directory = await mkdtemp(join(tmpdir(), "catalyst-demo-seed-"));
    const assetsDir = join(directory, "seed");
    await cp(resolve("clients/demo/seed"), assetsDir, { recursive: true });
    const instanceAssetsDir = join(directory, "instance");
    for (const entry of ["catalyst.yaml", "agents", "skills"]) {
      const source = resolve(input.instanceAssets, entry);
      // A working copy need not have skills.
      if (existsSync(source)) await cp(source, join(instanceAssetsDir, entry), { recursive: true });
    }
    const envFile = join(directory, ".env");
    const seed = (env: Record<string, string>) =>
      seedDemo({
        baseUrl: input.baseUrl,
        appConfigPath: input.configPath,
        assetsDir,
        instanceAssetsDir,
        env,
        envFile,
        fetchImpl
      });

    const first = await seed({});
    const before = await readInstance(input, fetchImpl);
    // The second run finds the key where the first one wrote it, as `pnpm demo:seed` does.
    const written = /^CATALYST_API_KEY=(.+)$/mu.exec(await readFile(envFile, "utf8"))?.[1];
    const second = await seed({ CATALYST_API_KEY: written ?? "" });
    const after = await readInstance(input, fetchImpl);
    seeded = { first, second, before, after, assetsDir, instanceAssetsDir, envFile };
  }, 120_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  return () => {
    if (!seeded) throw new Error("The seeded instance is not ready");
    return seeded;
  };
}

/** How many things each part of a run made, by the part's name. */
export function createdBy(report: SeedReport): Record<string, number> {
  return Object.fromEntries(report.steps.map((step) => [step.name, step.created]));
}

/** A run that found everything in place. */
const NOTHING_CREATED = {
  people: 0,
  "service principals": 0,
  "API keys": 0,
  "the instance's own agents and skills": 0,
  namespaces: 0,
  agents: 0,
  skills: 0,
  "grant rows": 0,
  "approval requests": 0,
  connections: 0
};

/** The second run made nothing, and the instance holds the same rows at the same revisions. */
export function expectSecondRunChangedNothing(seeded: SeededInstance): void {
  expect(createdBy(seeded.second)).toEqual(NOTHING_CREATED);
  const { client: _before, ...left } = seeded.before;
  const { client: _after, ...right } = seeded.after;
  expect(right).toEqual(left);
}

const reasonOf = (action: ReturnType<typeof checkAsset>[number]): CheckReason =>
  action.reason === "legacy"
    ? "individual_right"
    : action.reason === "holder_inactive"
      ? "inactive"
      : action.reason;

/**
 * Asks every question of the demo README's table the way the Check tab does: the tab's own
 * decision, from the three things the tab loads.
 */
export async function expectCheckAnswers(state: InstanceState): Promise<void> {
  for (const question of checkQuestions) {
    const email = people.find((person) => person.key === question.person)?.email;
    const holder = state.users.find((user) => user.email === email);
    if (!holder) throw new Error(`No seeded user for '${question.person}'`);
    const [effective, holderGrants] = await Promise.all([
      state.client.permissions.effective({ query: { holderKind: "user", holderId: holder.id } }),
      listAll((paging) =>
        state.client.permissions.list({
          query: { ...paging, holderKind: "user", holderId: holder.id }
        })
      )
    ]);
    const asset = { kind: question.kind, name: question.asset };
    const answers = checkAsset(
      effective,
      asset,
      checkedAssetId(asset, state.assetSummaries, holderGrants)
    );
    expect(
      Object.fromEntries(
        answers.map((answer) => [
          answer.verb,
          { allowed: answer.allowed, reason: reasonOf(answer) }
        ])
      ),
      `${question.person} on ${question.kind} ${question.asset}`
    ).toEqual(question.expect);
  }
}
