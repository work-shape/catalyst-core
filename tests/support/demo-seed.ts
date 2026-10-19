import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import {
  createApiClient,
  listAll,
  signInForSessionFetch,
  type ApiClient
} from "@work-shape/catalyst-api-client";
import {
  createPageBundleJobs,
  createSandboxPageBuild,
  type PageBuildRunner
} from "@work-shape/catalyst-server";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile
} from "@work-shape/catalyst-config-schema";
import { type JobWorker, type Logger } from "@work-shape/catalyst-core";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { createPostgresJobWorker } from "@work-shape/catalyst-postgres-store";
import { LocalWorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import type { ToolAssemblyDefinition } from "@work-shape/catalyst-tool-sdk";
import { checkAsset, checkedAssetId } from "@work-shape/catalyst-chat-ui/access";
import {
  SEED_EMAIL_SUFFIX,
  checkQuestions,
  connectionCheckQuestions,
  demoOperations,
  demoTools,
  people,
  seedDemo,
  workspace,
  workflowCheckQuestions,
  type CheckReason,
  type SeedReport
} from "@work-shape/catalyst-demo/seed";
import { pageBuildCommandFromSource } from "./page-build";
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
  /**
   * `sandbox` builds the seeded Apps with the real build command, as a process: the test then
   * holds that the committed sources build. Left out, a stand-in reads the manifest and hands
   * the files on, as `tests/support/app-instance.ts` does.
   */
  appBuild?: "sandbox";
  /** What is on the instance before the first run, put there as the superadmin. */
  prepare?: (client: ApiClient) => Promise<void>;
}

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

/** The top-level `key: value` lines of a manifest. The seeded manifests hold nothing else. */
function readFlatManifest(bytes: Uint8Array | undefined): Record<string, string> {
  const lines = new TextDecoder().decode(bytes ?? new Uint8Array()).split("\n");
  return Object.fromEntries(
    lines.flatMap((line) => {
      const found = /^([a-z]+):\s*(.+)$/u.exec(line);
      return found?.[1] && found[2] ? [[found[1], found[2]]] : [];
    })
  );
}

/** A build that needs no sandbox. What a real build does is the subject of the build's tests. */
const standInBuild: PageBuildRunner = async ({ files }) => {
  const read = readFlatManifest(files.find((file) => file.path === "app.yaml")?.bytes);
  const { id = "app", name = id, kit = "1.0.0", description } = read;
  return {
    status: "built",
    manifest: {
      id,
      name,
      kit,
      entry: "index.html",
      ...(description === undefined ? {} : { description })
    },
    kitVersion: kit,
    files: [{ path: "index.html", bytes: new TextEncoder().encode("<!doctype html>") }]
  };
};

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
  const workspaces = await listAll((paging) => client.workspaces.list({ query: paging }));
  const seededWorkspace = workspaces.find((candidate) => candidate.name === workspace.name);
  const [members, apps] = seededWorkspace
    ? await Promise.all([
        listAll((paging) =>
          client.workspaces.members.list({
            params: { collaborationWorkspaceId: seededWorkspace.id },
            query: paging
          })
        ),
        listAll((paging) =>
          client.assets.list({
            params: { kind: "app" },
            query: { ...paging, workspaceId: seededWorkspace.id }
          })
        )
      ])
    : [[], []];
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
    workspace: seededWorkspace && {
      id: seededWorkspace.id,
      members: members.map((member) => `${member.email}: ${member.role}`).sort()
    },
    apps: apps.map(({ id, name, title, revision, draftRevision, publishedRevision }) => ({
      id,
      name,
      title,
      revision,
      draftRevision,
      publishedRevision
    })),
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
  let builds: JobWorker | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "catalyst-demo-seed-"));
    // The files of the Apps go to a folder of the test: the config's own store is the
    // machine's, and the demo's lies where only its containers write.
    const loaded = await loadClientInstanceConfigFromFile(input.configPath);
    const filesRoot = join(directory, "files");
    const config = {
      ...loaded,
      infrastructure: {
        ...loaded.infrastructure,
        objectStorage: {
          ...loaded.infrastructure.objectStorage,
          files: { provider: "filesystem", root: filesRoot }
        }
      }
    };
    const instance = await createTestInstance({
      config,
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

    // The seed writes Apps from files, and a write waits for its build. No process of a test
    // instance serves `page.bundle`, so this worker does.
    const clientInstanceId = getClientInstanceId(config);
    builds = createPostgresJobWorker({
      stores: instance.stores,
      clientInstanceId,
      logger: silent,
      handlers: createPageBundleJobs({
        clientInstanceId,
        stores: instance.stores,
        pages: { objects: createFilesystemObjectStorage(filesRoot) },
        workspaceObjects: undefined,
        logger: silent,
        build:
          input.appBuild === "sandbox"
            ? createSandboxPageBuild({
                sandbox: new LocalWorkspaceCommandProcessExecutor(),
                tempRoot: join(directory, "builds"),
                command: await pageBuildCommandFromSource()
              })
            : standInBuild
      }).handlers
    });
    builds.start();

    // A push records its baseline beside the working copy, so the test pushes copies.
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

    if (input.prepare) await input.prepare((await readInstance(input, fetchImpl)).client);
    const first = await seed({});
    const before = await readInstance(input, fetchImpl);
    // The second run finds the key where the first one wrote it, as `pnpm demo:seed` does.
    const written = /^CATALYST_API_KEY=(.+)$/mu.exec(await readFile(envFile, "utf8"))?.[1];
    const second = await seed({ CATALYST_API_KEY: written ?? "" });
    const after = await readInstance(input, fetchImpl);
    seeded = { first, second, before, after, assetsDir, instanceAssetsDir, envFile };
  }, 120_000);

  afterAll(async () => {
    await builds?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  return () => {
    if (!seeded) throw new Error("The seeded instance is not ready");
    return seeded;
  };
}

/**
 * What the demo's own config asks of the environment beside the model key: the key of the
 * Secret Store and the secret of its Connection. Test values, made for one run of a file.
 */
export function demoConfigEnv(): Record<string, string> {
  return {
    OPENAI_API_KEY: "not-a-key",
    DEMO_SECRET_STORE_KEY: randomBytes(32).toString("base64"),
    DEMO_SAMPLE_MCP_KEY: randomBytes(32).toString("hex")
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
  "builder assets": 0,
  "approval requests": 0,
  "connection grant rows": 0,
  workspaces: 0,
  "workspace members": 0,
  "workspace bundles": 0,
  "workspace assets": 0,
  apps: 0
};

/** The second run made nothing, and the instance holds the same rows at the same revisions. */
export function expectSecondRunChangedNothing(
  seeded: SeededInstance,
  /** The parts the seed has on this instance beside the ones every instance has. */
  furtherParts: readonly string[] = []
): void {
  expect(createdBy(seeded.second)).toEqual({
    ...NOTHING_CREATED,
    ...Object.fromEntries(furtherParts.map((part) => [part, 0]))
  });
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
export async function expectCheckAnswers(
  state: InstanceState,
  questions: readonly (
    | (typeof checkQuestions)[number]
    | (typeof connectionCheckQuestions)[number]
    | (typeof workflowCheckQuestions)[number]
  )[] = checkQuestions
): Promise<void> {
  // The tab takes the kinds and the actions of each from the instance's registry.
  const { kinds } = await state.client.platform.context.get();
  for (const question of questions) {
    const registered = kinds.find((kind) => kind.kind === question.kind);
    if (!registered) throw new Error(`The instance has no kind '${question.kind}'`);
    // Agents and skills come with the agent configuration, any other kind has its own list.
    const listed =
      question.kind === "agent" || question.kind === "skill"
        ? state.assetSummaries
        : (
            await listAll((paging) =>
              state.client.assets.list({ params: { kind: question.kind }, query: paging })
            )
          ).map((asset) => ({ id: asset.id, kind: question.kind, name: asset.name }));
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
      checkedAssetId(asset, listed, holderGrants),
      registered.actions
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
