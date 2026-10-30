import type {
  AlwaysAllowLock,
  Policies,
  PolicyOperation,
  PolicyOperationKind,
  PolicySetting,
  SetPolicySettingRequest
} from "@work-shape/catalyst-api-contract";
import {
  ALWAYS_ALLOW_BY_CLASS,
  AppError,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX,
  PAGE_ACTION_OPERATION_PREFIX,
  WORKFLOW_OPERATION_PREFIX,
  auditActorFromIdentity,
  dataToolPrefixOf,
  mayAlwaysAllow,
  namesKnownOperations,
  namesOperation,
  resolvePolicy,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type CentralPolicySetting,
  type OperationDefinition,
  type PolicyValue
} from "@work-shape/catalyst-core";
import type { ResolvedChatServerOptions } from "../types";

// Instance > Policies (OP-2): the policy of every operation in one list, the admin's central
// settings, and the locks of "Always allow". Only a holder of `policy.manage` reads and changes
// them, through `policies.get`, `policies.set` and `policies.set_always_allow_lock`; each change
// is an audit event with the operation, its narrowing and the values, never a call's input.

export type PolicySettingsOptions = Pick<
  ResolvedChatServerOptions,
  "clientInstanceId" | "stores" | "config" | "operations" | "operationCalls" | "configAssets"
>;

/**
 * The operations of the Policies screen itself. No setting and no pattern may name them: a
 * `deny` there would leave nobody able to change the policy again.
 */
const OWN_OPERATIONS = ["policies.get", "policies.set", "policies.set_always_allow_lock"];

const now = (options: PolicySettingsOptions) => options.operations?.now?.() ?? new Date();

/** Where an operation comes from, as the screen groups it. */
function kindOf(
  definition: OperationDefinition,
  releaseNames: ReadonlySet<string>
): PolicyOperationKind {
  const { name } = definition;
  if (releaseNames.has(name)) return definition.http ? "platform" : "tool";
  const prefix = dataToolPrefixOf(name);
  if (prefix === "connection.") return "connection";
  if (prefix === DATA_STORE_OPERATION_PREFIX) return "data_store";
  if (prefix !== undefined || name.startsWith(PAGE_ACTION_OPERATION_PREFIX)) return "app";
  if (name.startsWith(WORKFLOW_OPERATION_PREFIX)) return "workflow";
  if (name.startsWith(KNOWLEDGE_OPERATION_PREFIX)) return "knowledge_base";
  return "platform";
}

/** One row: the value a call resolves to with no narrowed setting, and where it comes from. */
function operationRow(
  definition: OperationDefinition,
  input: {
    kind: PolicyOperationKind;
    instanceDefaults: Policies["defaults"];
    settings: readonly CentralPolicySetting[];
    releaseLocks: readonly string[];
    instanceLocks: readonly string[];
  }
): PolicyOperation {
  const resolved = resolvePolicy({
    definition,
    origin: { kind: "user" },
    instanceDefaults: input.instanceDefaults,
    // A setting narrowed to a workspace or a kind applies to some calls only; it is listed
    // among the settings and not taken as the row's value.
    centralSettings: input.settings.filter(
      (setting) => setting.workspaceId === undefined && setting.assetKind === undefined
    ),
    callerCanConfirm: false,
    canPause: true
  });
  const source =
    resolved.source === "declared_default" ||
    resolved.source === "central_setting" ||
    resolved.source === "policy_floor"
      ? resolved.source
      : "instance_default";
  const lock = input.releaseLocks.some((entry) => namesOperation(entry, definition.name))
    ? "release"
    : input.instanceLocks.some((entry) => namesOperation(entry, definition.name))
      ? "instance"
      : undefined;
  return {
    operation: definition.name,
    ...(definition.title ? { title: definition.title } : {}),
    kind: input.kind,
    effect: definition.effect,
    ...(definition.effect === "changing" && definition.changeClass
      ? { changeClass: definition.changeClass }
      : {}),
    value: resolved.value,
    source,
    ...(definition.defaultPolicy ? { declaredDefault: definition.defaultPolicy } : {}),
    ...(definition.policyFloor ? { floor: definition.policyFloor } : {}),
    mayAlwaysAllow: mayAlwaysAllow(definition, [...input.releaseLocks, ...input.instanceLocks]),
    ...(lock ? { alwaysAllowLock: lock } : {})
  };
}

/** Instance > Policies: every operation with its value, the settings and the locks. */
export async function readPolicies(options: PolicySettingsOptions): Promise<Policies> {
  const { clientInstanceId } = options;
  const registry = options.operationCalls.registry;
  const [listing, stored, named, storedLocks, workspaces] = await Promise.all([
    registry.list(),
    options.stores.centralPolicySettings.list({ clientInstanceId }),
    options.operations?.centralPolicySettings?.() ?? [],
    options.stores.centralPolicySettings.listLocks({ clientInstanceId }),
    options.stores.workspaces.listSharedWorkspaces({ clientInstanceId })
  ]);
  const workspaceName = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const releaseNames = new Set(registry.releaseNames());
  const releaseLocks = options.config.policy.alwaysAllow.locked;
  const instanceLocks = storedLocks.map((lock) => lock.operation);
  const instanceDefaults = options.config.policy.defaults;
  const settings = [...stored, ...named];
  const operations = listing.operations
    .filter((definition) => definition.available !== false)
    .map((definition) =>
      operationRow(definition, {
        kind: kindOf(definition, releaseNames),
        instanceDefaults,
        settings,
        releaseLocks,
        instanceLocks
      })
    )
    .sort((left, right) => left.operation.localeCompare(right.operation));
  const locks: AlwaysAllowLock[] = [
    ...releaseLocks.map((operation) => ({ operation, source: "release" as const })),
    ...storedLocks.map((lock) => ({
      operation: lock.operation,
      source: "instance" as const,
      updatedAt: lock.updatedAt
    }))
  ];
  return {
    defaults: instanceDefaults,
    alwaysAllowByClass: { ...ALWAYS_ALLOW_BY_CLASS },
    operations,
    // What a host's assembly names in code is no admin's setting and cannot be changed here.
    settings: stored.map((setting) => settingView(setting, workspaceName)),
    locks,
    workspaces: workspaces
      .map((workspace) => ({ id: workspace.id, name: workspace.name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    assetKinds: (options.configAssets?.kinds.kinds ?? []).map((kind) => kind.kind).sort(),
    truncated: listing.truncated.map(({ prefix, limit }) => ({ prefix, limit }))
  };
}

function settingView(
  setting: CentralPolicySetting & { updatedAt: string },
  workspaceName: ReadonlyMap<string, string>
): PolicySetting {
  const name =
    setting.workspaceId === undefined ? undefined : workspaceName.get(setting.workspaceId);
  return {
    operation: setting.operation,
    value: setting.value,
    ...(setting.workspaceId === undefined ? {} : { workspaceId: setting.workspaceId }),
    ...(name === undefined ? {} : { workspaceName: name }),
    ...(setting.assetKind === undefined ? {} : { assetKind: setting.assetKind }),
    updatedAt: setting.updatedAt
  };
}

/** Refuses an entry that names no operation of the instance, or the screen's own. */
function assertEntry(options: PolicySettingsOptions, operation: string): void {
  if (OWN_OPERATIONS.some((own) => namesOperation(operation, own))) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The Policies screen's own actions keep their default, so the policy can always be changed again",
      { reason: "policy_names_itself" }
    );
  }
  if (!namesKnownOperations(operation, options.operationCalls.registry)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'${operation}' names no operation of this instance. Name an operation exactly, or every operation under a prefix such as 'connection.crm.*'`,
      { reason: "unknown_operation" }
    );
  }
}

/**
 * Sets or removes one central setting. A reading operation runs or is refused, so an exact
 * name of one takes `allow` or `deny` alone; a pattern may hold reads and changes, and its
 * waiting value applies to the changes. A workspace named must be a shared workspace of the
 * instance and an asset kind a registered kind.
 */
export async function setPolicySetting(
  options: PolicySettingsOptions,
  input: SetPolicySettingRequest
): Promise<{ setting?: PolicySetting; previous?: PolicyValue }> {
  const { clientInstanceId } = options;
  assertEntry(options, input.operation);
  if (input.value === "confirm" || input.value === "approval") {
    const definition = input.operation.endsWith(".*")
      ? undefined
      : await options.operationCalls.registry.resolve(input.operation).catch(() => undefined);
    if (definition?.effect === "reading") {
      throw new AppError(
        "VALIDATION_FAILED",
        `'${input.operation}' only reads: it runs or is switched off, and asks nobody`,
        { reason: "reading_operation_waits" }
      );
    }
  }
  let workspaceName: string | undefined;
  if (input.workspaceId !== undefined) {
    const workspace = (
      await options.stores.workspaces.listSharedWorkspaces({ clientInstanceId })
    ).find((candidate) => candidate.id === input.workspaceId);
    if (!workspace) throw new AppError("NOT_FOUND", "There is no such shared workspace");
    workspaceName = workspace.name;
  }
  if (input.assetKind !== undefined && !options.configAssets?.kinds.get(input.assetKind)) {
    throw new AppError("VALIDATION_FAILED", `There is no asset kind '${input.assetKind}'`, {
      reason: "unknown_asset_kind"
    });
  }
  const at = now(options).toISOString();
  const { previous } = await options.stores.centralPolicySettings.set({
    clientInstanceId,
    operation: input.operation,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.assetKind === undefined ? {} : { assetKind: input.assetKind }),
    value: input.value,
    at
  });
  return {
    ...(input.value === null
      ? {}
      : {
          setting: {
            operation: input.operation,
            value: input.value,
            ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
            ...(workspaceName === undefined ? {} : { workspaceName }),
            ...(input.assetKind === undefined ? {} : { assetKind: input.assetKind }),
            updatedAt: at
          }
        }),
    ...(previous === undefined ? {} : { previous })
  };
}

/**
 * Locks or unlocks "Always allow" for one operation or pattern. A lock of release config holds
 * whatever the screen says: lifting one that names the entry is refused with the reason.
 */
export async function setAlwaysAllowLock(
  options: PolicySettingsOptions,
  input: { operation: string; locked: boolean }
): Promise<{ operation: string; locked: boolean; wasLocked: boolean }> {
  assertEntry(options, input.operation);
  if (
    !input.locked &&
    options.config.policy.alwaysAllow.locked.some((entry) => namesOperation(entry, input.operation))
  ) {
    throw new AppError(
      "FORBIDDEN",
      "Release config locks Always allow for this action; only whoever runs the instance can lift that lock",
      { reason: "locked_by_release" }
    );
  }
  const { wasLocked } = await options.stores.centralPolicySettings.setLock({
    clientInstanceId: options.clientInstanceId,
    operation: input.operation,
    locked: input.locked,
    at: now(options).toISOString()
  });
  return { operation: input.operation, locked: input.locked, wasLocked };
}

/** The audit event of a changed setting: the entry, its narrowing and the two values. */
export async function recordPolicySettingChanged(
  audit: AuditRecorder,
  input: {
    actor: AuthenticatedIdentity;
    correlationId: string;
    request: SetPolicySettingRequest;
    previous: PolicyValue | undefined;
  }
): Promise<void> {
  const { request } = input;
  await audit.record({
    type: "governance.policy_setting_changed",
    status: "success",
    actor: auditActorFromIdentity(input.actor),
    correlationId: input.correlationId,
    subject: request.operation,
    metadata: {
      operation: request.operation,
      ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      ...(request.assetKind === undefined ? {} : { assetKind: request.assetKind }),
      before: input.previous ?? "default",
      after: request.value ?? "default"
    }
  });
}

/** The audit event of a lock set or lifted: the entry and whether it is locked now. */
export async function recordAlwaysAllowLockChanged(
  audit: AuditRecorder,
  input: {
    actor: AuthenticatedIdentity;
    correlationId: string;
    operation: string;
    locked: boolean;
  }
): Promise<void> {
  await audit.record({
    type: "governance.always_allow_lock_changed",
    status: "success",
    actor: auditActorFromIdentity(input.actor),
    correlationId: input.correlationId,
    subject: input.operation,
    metadata: { operation: input.operation, locked: input.locked }
  });
}
