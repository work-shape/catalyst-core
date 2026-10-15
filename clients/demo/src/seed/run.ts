import { readFile } from "node:fs/promises";
import {
  createApiClient,
  signInForSessionFetch,
  type ApiClientOptions
} from "@work-shape/catalyst-api-client";
import { API_KEY_ENV_NAME, writeApiKeyToEnvFile } from "@work-shape/catalyst-client-assembly";
import {
  ApiKeyExchangeError,
  canonicalizeAgentConfig,
  canonicalizeSkillConfig,
  createConfigApi,
  readManifest,
  readWorkingCopy
} from "@work-shape/catalyst-cli";
import { loadClientInstanceConfigFromFile } from "@work-shape/catalyst-config-schema";
import {
  createEnvironmentSecretResolver,
  resolveOptionalSecret,
  type SecretResolver
} from "@work-shape/catalyst-core";
import {
  CONNECTIONS_MODULE,
  CONNECTION_KIND,
  createSeedApi,
  offeredNowhere,
  type SeedApi
} from "./api";
import { seedApps, seedWorkspace } from "./apps";
import { seedBuilder } from "./builder";
import { seedWorkflows } from "./workflows";
import { seedWorkspaceAssets } from "./workspace-assets";
import {
  assertLocalDevelopmentHost,
  assertLoopbackAddress,
  localOnlyFetch,
  type ResolveHost
} from "./adapters/local-network";
import {
  PERSON_PERMISSION_REFS,
  SEEDED_CONNECTION,
  cliPrincipal,
  connectionGrants,
  firstDraft,
  grants,
  heldSkill,
  heldSkillChange,
  namespaces,
  people,
  personOf,
  type PersonKey
} from "./company";
import type { SeedStep } from "./step";

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
  /** Replaces the lookup of the instance's host name. For tests. */
  resolveHost?: ResolveHost;
}

export interface SeedReport {
  steps: SeedStep[];
}

/**
 * Fills a running local instance with the test company. Everything goes through the
 * instance's own operations and the config CLI. Each part reads what is there first and adds
 * only what is missing, so a second run changes nothing.
 */
export async function seedDemo(options: SeedOptions): Promise<SeedReport> {
  const origin = assertLocalDevelopmentHost(options.baseUrl);
  await assertLoopbackAddress(origin, options.resolveHost);
  const baseUrl = origin.origin;
  // Every request of the run goes through this: the sign-ins, the operations, the config CLI.
  const fetchImpl = localOnlyFetch(origin, options.fetchImpl);
  const { env } = options;
  const config = await loadClientInstanceConfigFromFile(options.appConfigPath);
  const standalone = config.auth.standalone;
  const superadmin = standalone?.seedUsers.find((user) => user.roles.includes("superadmin"));
  const uiOrigin = env.CHAT_UI_ORIGIN ?? standalone?.trustedOrigins[0];
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
    !uiOrigin ||
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
          origin: uiOrigin,
          email,
          password,
          fetchImpl
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

  const instance = { ...options, baseUrl, fetchImpl };
  const userIds = await seedPeople(root, password, moduleOn("userInvitations"), steps);
  const apiKey = await seedCliKey(root, instance, secrets, steps);
  await seedInstanceAssets(root, instance, apiKey, steps);
  await seedNamespaces(root, as, steps);
  await seedAssets(root, as, instance, apiKey, steps);
  await seedGrants(root, as, userIds, steps);
  await seedBuilder(root, as, modules, instance.assetsDir, steps);
  await seedHeldCalls(root, as, steps);
  await seedConnections(root, as, userIds, modules, steps);
  const workspaceId = await seedWorkspace(as, steps);
  await seedWorkspaceAssets(as, workspaceId, steps);
  await seedApps(modules, as, workspaceId, instance.assetsDir, steps);
  const seededWorkflows = await seedWorkflows(root, modules, instance.assetsDir);
  if (seededWorkflows) steps.push(seededWorkflows);
  return { steps };
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
  let invitationsRecovered = 0;
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
    // A run that stopped between creating the person and mailing them left no invitation.
    if (
      person.invited &&
      invitationsOn &&
      found.lastAuthenticatedAt === undefined &&
      !(await root.invitationWasSent(found.id))
    ) {
      await root.sendInvitation(found.id);
      invitationsRecovered += 1;
    }
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
      : invitationsRecovered
        ? { note: "Mailed the invitation an earlier run created the person for and did not send." }
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
  "baseUrl" | "envFile" | "assetsDir" | "instanceAssetsDir"
> & { fetchImpl: NonNullable<SeedOptions["fetchImpl"]> };

async function keyIsAccepted(options: InstanceOptions, apiKey: string): Promise<boolean> {
  try {
    await createConfigApi({
      baseUrl: options.baseUrl,
      apiKey,
      fetchImpl: options.fetchImpl
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

/**
 * Writes assets of a working copy in one batch with the key of the config CLI, as a push
 * does. The seed owns these names: each asset is written against the revision the instance
 * holds as this run reads it, the revision of its delete included, so the file replaces what
 * was changed there. Only a write that arrives between that read and the batch refuses it.
 * Without selectors the batch carries every asset and the default agent of the working copy.
 */
async function push(
  options: InstanceOptions,
  apiKey: string,
  workingDir: string,
  selectors?: readonly string[]
): Promise<void> {
  const local = await readWorkingCopy(workingDir, await readManifest(workingDir));
  const api = await createConfigApi({
    baseUrl: options.baseUrl,
    apiKey,
    fetchImpl: options.fetchImpl
  });
  const assets = [
    ...local.agents.map((config) => ({ kind: "agent", name: config.name, config: { ...config } })),
    ...local.skills.map((config) => ({ kind: "skill", name: config.name, config: { ...config } }))
  ].filter((asset) => selectors?.includes(`${asset.kind}:${asset.name}`) ?? true);
  const items = [];
  for (const { kind, name, config } of assets) {
    const held =
      (await api.getAsset(kind, name)) ??
      (await api.getLatestRevision(kind, name).catch(() => undefined));
    items.push({ type: "put" as const, kind, config, expectedRevision: held?.revision ?? null });
  }
  try {
    const outcome = await api.syncAssets({
      items,
      ...(selectors === undefined
        ? {
            defaultAgentName: local.defaultAgentName ?? null,
            expectedDefaultAgentName: (await api.getOverview()).defaultAgentName ?? null
          }
        : {})
    });
    if (outcome.status === "pending_approval") {
      throw new Error("the instance holds the push for an approval");
    }
  } catch (error) {
    throw new Error(
      `The config push of ${workingDir} failed:\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
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
    ).saveAsset("agent", {
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

  // An agent saved or pushed in no workspace starts hidden: the seed offers it everywhere.
  const { assets } = await root.assetsOverview();
  for (const agent of local.agents) {
    const stored = assets.find((asset) => asset.kind === "agent" && asset.name === agent.name);
    if (stored && offeredNowhere(stored.availability)) await root.showAgentEverywhere(agent.name);
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

/**
 * Leaves two calls waiting for an approval, where the instance sends such calls to one: a new
 * skill, and a change of one paragraph of a skill the seed pushed. The change is asked for
 * only while the request for the new skill waits. That request is how the seed knows that the
 * instance holds such a call: on an instance that holds none, the change would be written at
 * once and pushed away again by the next run.
 */
async function seedHeldCalls(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  steps: SeedStep[]
): Promise<void> {
  let created = 0;
  let existing = 0;
  const notes: string[] = [];
  const waits = async (person: PersonKey, skillName: string) =>
    (await (await as(person)).listOwnApprovalRequests()).some(
      (request) =>
        request.status === "pending" && JSON.stringify(request.payload).includes(`"${skillName}"`)
    );

  const newName = heldSkill.config.name;
  let holds = false;
  if (await root.getAsset("skill", newName)) {
    notes.push(
      `The skill '${newName}' exists: its request was decided, or the instance asks for no approval.`
    );
  } else if (await waits(heldSkill.requestedBy, newName)) {
    existing += 1;
    holds = true;
  } else if (
    (await (await as(heldSkill.requestedBy)).saveAsset("skill", heldSkill.config)) ===
    "pending_approval"
  ) {
    created += 1;
    holds = true;
  } else {
    notes.push(
      `The instance asks for no approval of a new skill in 'hr-', so '${newName}' was created at once and nothing waits in the Inbox.`
    );
  }

  const { skillName, before, after } = heldSkillChange;
  if (await waits(heldSkillChange.requestedBy, skillName)) {
    existing += 1;
  } else if (!holds) {
    notes.push(
      `No change of '${skillName}' was requested: the seed asks for it only while the request for '${newName}' waits.`
    );
  } else {
    const stored = await root.getAsset("skill", skillName);
    const content = stored?.config.content;
    if (!stored || typeof content !== "string" || !content.includes(before)) {
      throw new Error(`The skill '${skillName}' has no paragraph '${before}' to change`);
    }
    const outcome = await (
      await as(heldSkillChange.requestedBy)
    ).saveAsset(
      "skill",
      { ...stored.config, name: skillName, content: content.replace(before, after) },
      stored.revision
    );
    if (outcome === "pending_approval") {
      created += 1;
    } else {
      notes.push(
        `The instance asks for no approval of a changed skill in 'hr-', so '${skillName}' was changed at once.`
      );
    }
  }
  steps.push({
    name: "approval requests",
    created,
    existing,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {})
  });
}

/**
 * The Connection itself comes from release config: the instance creates it at start and stores
 * its secret, and the seed creates neither. Where it is there, the seed gives the people of
 * `connectionGrants` their rights on it.
 */
async function seedConnections(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  userIds: ReadonlyMap<PersonKey, string>,
  modules: Awaited<ReturnType<SeedApi["listModules"]>>,
  steps: SeedStep[]
): Promise<void> {
  const name = "connection grant rows";
  const module = modules.find((candidate) => candidate.name === CONNECTIONS_MODULE);
  if (module?.enabled !== true || !module.kinds.includes(CONNECTION_KIND)) {
    steps.push({
      name,
      created: 0,
      existing: 0,
      note: "This instance has no Connections module, so no right on a Connection was granted."
    });
    return;
  }
  const connection = await root.getAsset(CONNECTION_KIND, SEEDED_CONNECTION);
  if (!connection) {
    steps.push({
      name,
      created: 0,
      existing: 0,
      note: `This instance has no Connection '${SEEDED_CONNECTION}': the demo's release config brings it, so no right on it was granted.`
    });
    return;
  }
  const existing = await root.listGrants();
  let created = 0;
  let total = 0;
  for (const grant of connectionGrants) {
    const holderId = userIds.get(grant.holder);
    if (!holderId) throw new Error(`The seed has no user for '${grant.holder}'`);
    for (const verb of grant.verbs) {
      total += 1;
      const action = `${CONNECTION_KIND}.${verb}`;
      const there = existing.some(
        (row) =>
          row.holderKind === "user" &&
          row.holderId === holderId &&
          row.action === action &&
          row.effect === "allow" &&
          row.scopeKind === "asset" &&
          row.scopeId === connection.id
      );
      if (there) continue;
      await (
        await as(grant.grantedBy)
      ).grant({
        holderKind: "user",
        holderId,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: connection.id
      });
      created += 1;
    }
  }
  steps.push({ name, created, existing: total - created });
}
