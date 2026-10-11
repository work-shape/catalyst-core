import { readFile } from "node:fs/promises";
import {
  createApiClient,
  signInForSessionFetch,
  type ApiClientOptions
} from "@vivd-catalyst/api-client";
import {
  API_KEY_ENV_NAME,
  ApiKeyExchangeError,
  canonicalizeAgentConfig,
  canonicalizeSkillConfig,
  createConfigApi,
  readManifest,
  readWorkingCopy,
  runCli,
  writeApiKeyToEnvFile
} from "@vivd-catalyst/config-cli";
import { loadClientInstanceConfigFromFile } from "@vivd-catalyst/config-schema";
import {
  createEnvironmentSecretResolver,
  resolveOptionalSecret,
  type SecretResolver
} from "@vivd-catalyst/core";
import { createSeedApi, type SeedApi } from "./api";
import {
  PERSON_PERMISSION_REFS,
  cliPrincipal,
  firstDraft,
  grants,
  heldSkill,
  namespaces,
  people,
  type PersonKey,
  type SeedPerson
} from "./company";

/** The variable that replaces the password of the seeded people. */
const SEED_PASSWORD_ENV_NAME = "DEMO_SEED_PASSWORD";

/**
 * The password every seeded person signs in with where the variable is not set. A fixed test
 * value for a local development instance, like the `developmentPassword` of the demo's config.
 */
const SEED_DEVELOPMENT_PASSWORD = "nordlicht-demo-password";

type Env = Readonly<Record<string, string | undefined>>;

interface SeedOptions {
  /** The running instance. Any host that is not a local development host is refused. */
  baseUrl: string;
  /** The client instance config whose development superadmin signs in first. */
  appConfigPath: string;
  /** The config working copy with the company's agents and skills. */
  assetsDir: string;
  /**
   * The instance's own config working copy, with its default agent. It is pushed first where
   * the instance does not have that agent yet, so the default agent is the instance's own and
   * not the first agent of the company.
   */
  instanceAssetsDir: string;
  env: Env;
  /** The env file a newly issued key of the config CLI is written to. */
  envFile: string;
  /** Replaces the network. For tests. */
  fetchImpl?: ApiClientOptions["fetchImpl"];
}

/** What one part of the seed did: how many things it made, and how many were there already. */
interface SeedStep {
  name: string;
  created: number;
  existing: number;
  note?: string;
}

export interface SeedReport {
  steps: SeedStep[];
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const LOCAL_HOST_SUFFIXES = [".localhost", ".test"];

/** The seed signs in with development passwords, so it runs against this machine only. */
export function assertLocalDevelopmentHost(baseUrl: string): void {
  const { hostname } = new URL(baseUrl);
  if (
    !LOCAL_HOSTS.includes(hostname) &&
    !LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error(
      `Refusing to seed '${hostname}'. The seed signs in with development passwords and only runs against localhost, 127.0.0.1, ::1 or a name ending in .localhost or .test.`
    );
  }
}

/**
 * Fills a running local instance with the test company. Everything goes through the
 * instance's own operations and the config CLI. Each part reads what is there first and adds
 * only what is missing, so a second run changes nothing.
 */
export async function seedDemo(options: SeedOptions): Promise<SeedReport> {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  assertLocalDevelopmentHost(baseUrl);
  const { env } = options;
  const config = await loadClientInstanceConfigFromFile(options.appConfigPath);
  const standalone = config.auth.standalone;
  const superadmin = standalone?.seedUsers.find((user) => user.roles.includes("superadmin"));
  const origin = env.CHAT_UI_ORIGIN ?? standalone?.trustedOrigins[0];
  const secrets = createEnvironmentSecretResolver({
    env,
    readSecretFile: (path) => readFile(path, "utf8")
  });
  const superadminPassword =
    (superadmin && (await resolveOptionalSecret(secrets, superadmin.passwordEnvName))) ??
    superadmin?.developmentPassword;
  if (
    config.clientInstance.environment !== "development" ||
    !superadmin ||
    !origin ||
    !superadminPassword
  ) {
    throw new Error(
      `${options.appConfigPath} is not a development config with a seeded superadmin, a development password and a trusted origin.`
    );
  }

  const signIn = async (email: string, password: string): Promise<SeedApi> =>
    createSeedApi(
      createApiClient({
        baseUrl,
        fetchImpl: await signInForSessionFetch({
          apiBaseUrl: baseUrl,
          origin,
          email,
          password,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
        })
      })
    );
  const root = await signIn(
    (superadmin.emailEnvName && env[superadmin.emailEnvName]) || superadmin.email,
    superadminPassword
  );
  const password =
    (await resolveOptionalSecret(secrets, SEED_PASSWORD_ENV_NAME)) ?? SEED_DEVELOPMENT_PASSWORD;
  const sessions = new Map<PersonKey, Promise<SeedApi>>();
  /** The session of one seeded person, so that a change carries the name of who made it. */
  const as = (key: PersonKey): Promise<SeedApi> => {
    const session = sessions.get(key) ?? signIn(personOf(key).email, password);
    sessions.set(key, session);
    return session;
  };

  const steps: SeedStep[] = [];
  const modules = await root.listModules();
  const moduleOn = (name: string) =>
    modules.some((module) => module.name === name && module.enabled);

  const instance = { ...options, baseUrl };
  const userIds = await seedPeople(root, password, moduleOn("userInvitations"), steps);
  const apiKey = await seedCliKey(root, instance, secrets, steps);
  await seedInstanceAssets(root, instance, apiKey, steps);
  await seedNamespaces(root, as, steps);
  await seedAssets(root, as, instance, apiKey, steps);
  await seedGrants(root, as, userIds, steps);
  await seedHeldCall(root, as, steps);
  seedConnections(modules, steps);
  return { steps };
}

function personOf(key: PersonKey): SeedPerson {
  const found = people.find((person) => person.key === key);
  if (!found) throw new Error(`The seed has no person '${key}'`);
  return found;
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((entry) => right.includes(entry));

async function seedPeople(
  root: SeedApi,
  password: string,
  invitationsOn: boolean,
  steps: SeedStep[]
): Promise<Map<PersonKey, string>> {
  const existing = await root.listUsers();
  const ids = new Map<PersonKey, string>();
  let created = 0;
  let invitationsSkipped = 0;
  for (const person of people) {
    const wanted = {
      displayLabel: person.displayLabel,
      roles: person.roles,
      permissions: person.permissions,
      permissionRefs: PERSON_PERMISSION_REFS,
      status: person.status
    };
    const found = existing.find((user) => user.email?.toLowerCase() === person.email);
    if (!found) {
      const user = await root.createUser({
        ...wanted,
        email: person.email,
        ...(person.invited ? {} : { password })
      });
      ids.set(person.key, user.id);
      created += 1;
      if (person.invited) {
        if (invitationsOn) await root.sendInvitation(user.id);
        else invitationsSkipped += 1;
      }
      continue;
    }
    ids.set(person.key, found.id);
    if (
      found.displayLabel !== wanted.displayLabel ||
      found.status !== wanted.status ||
      !sameSet(found.roles, wanted.roles) ||
      !sameSet(found.permissions, wanted.permissions) ||
      !sameSet(found.permissionRefs, wanted.permissionRefs)
    ) {
      await root.updateUser(found.id, wanted);
    }
  }
  steps.push({
    name: "people",
    created,
    existing: people.length - created,
    ...(invitationsSkipped
      ? { note: "No invitation was mailed: the module userInvitations is off on this instance." }
      : {})
  });
  return ids;
}

const sameList = (left: readonly string[] | null, right: readonly string[] | null) =>
  left === null || right === null ? left === right : sameSet(left, right);

async function seedNamespaces(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  steps: SeedStep[]
): Promise<void> {
  const [existing, overview] = await Promise.all([root.listNamespaces(), root.assetsOverview()]);
  const instanceModels = overview.references.modelBindingIds;
  let created = 0;
  for (const namespace of namespaces) {
    const wanted = {
      displayName: namespace.displayName,
      allowedToolNames: namespace.allowedToolNames ?? null,
      allowedModelBindingIds:
        namespace.allowedModelBindingIds?.filter((id) => instanceModels.includes(id)) ?? null
    };
    const found = existing.find((candidate) => candidate.prefix === namespace.prefix);
    if (!found) {
      await (
        await as(namespace.registeredBy)
      ).createNamespace({ prefix: namespace.prefix, ...wanted });
      created += 1;
    } else if (
      found.displayName !== wanted.displayName ||
      !sameList(found.allowedToolNames, wanted.allowedToolNames) ||
      !sameList(found.allowedModelBindingIds, wanted.allowedModelBindingIds)
    ) {
      await root.updateNamespace(namespace.prefix, wanted);
    }
  }
  steps.push({ name: "namespaces", created, existing: namespaces.length - created });
}

type InstanceOptions = Pick<
  SeedOptions,
  "baseUrl" | "envFile" | "fetchImpl" | "assetsDir" | "instanceAssetsDir"
>;

async function keyIsAccepted(options: InstanceOptions, apiKey: string): Promise<boolean> {
  try {
    await createConfigApi({
      baseUrl: options.baseUrl,
      apiKey,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });
    return true;
  } catch (error) {
    if (error instanceof ApiKeyExchangeError) return false;
    throw error;
  }
}

/**
 * The key the config CLI pushes with. The key of an earlier run is kept while the instance
 * still accepts it; otherwise the CLI's service principal gets a new one, written to the env
 * file and never printed.
 */
async function seedCliKey(
  root: SeedApi,
  options: InstanceOptions,
  secrets: SecretResolver,
  steps: SeedStep[]
): Promise<string> {
  const principals = await root.listServicePrincipals();
  const found = principals.find(
    (detail) =>
      detail.principal.displayLabel === cliPrincipal.displayLabel &&
      detail.principal.status === "active"
  );
  const known = await resolveOptionalSecret(secrets, API_KEY_ENV_NAME);
  if (found && known && (await keyIsAccepted(options, known))) {
    steps.push({ name: "service principals", created: 0, existing: 1 });
    steps.push({ name: "API keys", created: 0, existing: 1 });
    return known;
  }
  const { principal } =
    found ??
    (await root.createServicePrincipal({
      displayLabel: cliPrincipal.displayLabel,
      description: cliPrincipal.description,
      permissions: [...cliPrincipal.permissions]
    }));
  const apiKey = await root.createApiKey(principal.id, {
    name: cliPrincipal.keyName,
    scopes: [...cliPrincipal.scopes]
  });
  const file = await writeApiKeyToEnvFile(options.envFile, API_KEY_ENV_NAME, apiKey);
  steps.push({ name: "service principals", created: found ? 0 : 1, existing: found ? 1 : 0 });
  steps.push({
    name: "API keys",
    created: 1,
    existing: 0,
    note: `Wrote ${API_KEY_ENV_NAME} to ${file}.`
  });
  return apiKey;
}

/** Pushes a working copy with the config CLI, the way `pnpm config:push` does. */
async function push(
  options: InstanceOptions,
  apiKey: string,
  workingDir: string,
  selectors: string[] = []
): Promise<void> {
  const output: string[] = [];
  const code = await runCli(
    [
      "config",
      "push",
      "--force",
      "--dir",
      workingDir,
      "--instance",
      options.baseUrl,
      ...selectors.flatMap((selector) => ["--only", selector])
    ],
    {
      cwd: workingDir,
      env: { [API_KEY_ENV_NAME]: apiKey },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text)
    }
  );
  if (code !== 0) {
    throw new Error(`The config push of ${workingDir} failed:\n${output.join("")}`);
  }
}

/**
 * The instance's own agents and skills, where a database was never pushed to. An instance
 * that has its default agent is left alone: what was changed there since stays.
 */
async function seedInstanceAssets(
  root: SeedApi,
  options: InstanceOptions,
  apiKey: string,
  steps: SeedStep[]
): Promise<void> {
  const name = "the instance's own agents and skills";
  const manifest = await readManifest(options.instanceAssetsDir);
  const local = await readWorkingCopy(options.instanceAssetsDir, manifest);
  const count = local.agents.length + local.skills.length;
  if (
    manifest.defaultAgentName === undefined ||
    (await root.getAsset("agent", manifest.defaultAgentName))
  ) {
    steps.push({ name, created: 0, existing: count });
    return;
  }
  await push(options, apiKey, options.instanceAssetsDir);
  steps.push({ name, created: count, existing: 0 });
}

const sameDefinition = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

async function seedAssets(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  options: InstanceOptions,
  apiKey: string,
  steps: SeedStep[]
): Promise<void> {
  const local = await readWorkingCopy(options.assetsDir, await readManifest(options.assetsDir));

  // The first draft is saved by a person, so the push below is the agent's second revision.
  const drafted = local.agents.find((agent) => agent.name === firstDraft.agentName);
  if (!drafted) throw new Error(`The working copy has no agent '${firstDraft.agentName}'`);
  if (!(await root.getAsset("agent", drafted.name))) {
    await (
      await as(firstDraft.savedBy)
    ).createAsset("agent", {
      ...canonicalizeAgentConfig(drafted),
      instructions: firstDraft.instructions,
      toolNames: firstDraft.toolNames,
      skillNames: firstDraft.skillNames
    });
  }

  // Only what differs is pushed: a push writes a revision for every asset it names.
  const differing: string[] = [];
  const counts = { agent: { created: 0, existing: 0 }, skill: { created: 0, existing: 0 } };
  for (const agent of local.agents) {
    const remote = await root.getAsset("agent", agent.name);
    const same =
      remote !== undefined &&
      sameDefinition(canonicalizeAgentConfig(remote.config), canonicalizeAgentConfig(agent));
    if (!same) differing.push(`agent:${agent.name}`);
    counts.agent[same ? "existing" : "created"] += 1;
  }
  for (const skill of local.skills) {
    const remote = await root.getAsset("skill", skill.name);
    const same =
      remote !== undefined &&
      sameDefinition(canonicalizeSkillConfig(remote.config), canonicalizeSkillConfig(skill));
    if (!same) differing.push(`skill:${skill.name}`);
    counts.skill[same ? "existing" : "created"] += 1;
  }
  if (differing.length > 0) await push(options, apiKey, options.assetsDir, differing);

  // A pushed agent is hidden in every workspace until somebody sets where it is offered.
  const { assets } = await root.assetsOverview();
  for (const agent of local.agents) {
    const stored = assets.find((asset) => asset.kind === "agent" && asset.name === agent.name);
    if (stored && !stored.availability) await root.showAgentEverywhere(agent.name);
  }
  steps.push({ name: "agents", ...counts.agent });
  steps.push({ name: "skills", ...counts.skill });
}

async function seedGrants(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  userIds: ReadonlyMap<PersonKey, string>,
  steps: SeedStep[]
): Promise<void> {
  const [existing, { assets }] = await Promise.all([root.listGrants(), root.assetsOverview()]);
  let created = 0;
  let total = 0;
  for (const grant of grants) {
    const holderId = userIds.get(grant.holder);
    if (!holderId) throw new Error(`The seed has no user for '${grant.holder}'`);
    let scope:
      { scopeKind: "namespace"; namespace: string } | { scopeKind: "asset"; scopeId: string };
    if ("namespace" in grant.scope) {
      scope = { scopeKind: "namespace", namespace: grant.scope.namespace };
    } else {
      const name = grant.scope.asset;
      const asset = assets.find((entry) => entry.kind === grant.kind && entry.name === name);
      if (!asset?.id) throw new Error(`The instance has no ${grant.kind} '${name}' to grant on`);
      scope = { scopeKind: "asset", scopeId: asset.id };
    }
    for (const verb of grant.verbs) {
      total += 1;
      const action = `${grant.kind}.${verb}`;
      const there = existing.some(
        (row) =>
          row.holderKind === "user" &&
          row.holderId === holderId &&
          row.action === action &&
          row.effect === grant.effect &&
          row.scopeKind === scope.scopeKind &&
          (scope.scopeKind === "namespace"
            ? row.namespace === scope.namespace
            : row.scopeId === scope.scopeId)
      );
      if (there) continue;
      await (
        await as(grant.grantedBy)
      ).grant({
        holderKind: "user",
        holderId,
        action,
        effect: grant.effect,
        ...scope
      });
      created += 1;
    }
  }
  steps.push({ name: "grant rows", created, existing: total - created });
}

/** Leaves one call waiting for an approval, where the instance sends such a call to one. */
async function seedHeldCall(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  steps: SeedStep[]
): Promise<void> {
  const name = "approval requests";
  const skillName = heldSkill.config.name;
  if (await root.getAsset("skill", skillName)) {
    steps.push({
      name,
      created: 0,
      existing: 0,
      note: `The skill '${skillName}' exists: its request was decided, or the instance asks for no approval.`
    });
    return;
  }
  const requester = await as(heldSkill.requestedBy);
  const waiting = (await requester.listOwnApprovalRequests()).some(
    (request) =>
      request.status === "pending" && JSON.stringify(request.payload).includes(`"${skillName}"`)
  );
  if (waiting) {
    steps.push({ name, created: 0, existing: 1 });
    return;
  }
  const outcome = await requester.createAsset("skill", heldSkill.config);
  steps.push(
    outcome === "pending_approval"
      ? { name, created: 1, existing: 0 }
      : {
          name,
          created: 0,
          existing: 0,
          note: `The instance asks for no approval of a new skill in 'hr-', so '${skillName}' was created at once and nothing waits in the Inbox.`
        }
  );
}

/** The module and the asset kind Connections come with. */
const CONNECTIONS_MODULE = "connections";
const CONNECTION_KIND = "connection";

/**
 * Connections are seeded once a Connection can reach something: the platform has the module
 * and the kind, and no connector type and no Secret Store yet. Until the seed carries a
 * Connection, an instance that has the module and the kind is told so instead of being left
 * without a word.
 */
function seedConnections(
  modules: Awaited<ReturnType<SeedApi["listModules"]>>,
  steps: SeedStep[]
): void {
  const module = modules.find((candidate) => candidate.name === CONNECTIONS_MODULE);
  const available = module?.enabled === true && module.kinds.includes(CONNECTION_KIND);
  steps.push({
    name: "connections",
    created: 0,
    existing: 0,
    note: available
      ? "This instance has Connections, and the seed brings none yet. See the demo README."
      : "This instance has no Connections module, so none was seeded."
  });
}
