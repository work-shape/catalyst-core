import {
  AppError,
  auditActorFromIdentity,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  mayAlwaysAllow,
  resolvePolicy,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type OperationDefinition,
  type OperationRegistry,
  type PersonPolicySetting,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "@work-shape/catalyst-tool-execution";

// A person's own confirmation settings (OP-6): per operation Always allow, Ask me or Never,
// for the calls their agents make for them. Only the person reads and sets their own, by their
// click in the interface: the settings are derived from the signed-in person, never named by a
// parameter, and a decision the person made is the only other way one is set.

/** How many of the person's recent agent calls the list reads to name the operations used. */
const RECENT_AGENT_CALLS = 200;
/** How far back the list looks for the operations their agents called. */
const RECENT_DAYS = 90;

export interface OperationSettingsDeps {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "userOperationSettings" | "operationRuns">;
  registry: Pick<OperationRegistry, "resolve">;
  policy: Pick<
    RunOperationDeps["policy"],
    "instanceDefaults" | "centralSettings" | "alwaysAllowLocked"
  >;
  now?: () => Date;
}

/** One row of You > Confirmations. */
interface OperationSettingView {
  operation: string;
  title?: string;
  effect: OperationDefinition["effect"];
  changeClass?: NonNullable<OperationDefinition["changeClass"]>;
  value?: PersonPolicySetting;
  mayAlwaysAllow: boolean;
  updatedAt?: string;
}

/** The person a setting belongs to: a signed-in person, never a service principal. */
function settingOwner(actor: AuthenticatedIdentity): string {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Only a person sets their own confirmations");
  }
  return getSubjectUserId(actor);
}

/**
 * Why "Always allow" cannot be set for an operation, or nothing where it can: the admin does
 * not permit it (its class, or a lock), or the policy holds the operation at `approval` or
 * `deny`, which a person's setting never lowers.
 */
export async function alwaysAllowRefusal(
  deps: Pick<OperationSettingsDeps, "policy">,
  definition: OperationDefinition
): Promise<string | undefined> {
  if (!mayAlwaysAllow(definition, deps.policy.alwaysAllowLocked)) {
    return "Your administrator decides whether this action asks you first; Always allow is not available for it.";
  }
  // The value the admin and the operation ask for, before any person's setting or floor.
  const resolved = resolvePolicy({
    definition,
    origin: { kind: "user" },
    instanceDefaults: deps.policy.instanceDefaults,
    centralSettings: await deps.policy.centralSettings(),
    callerCanConfirm: false,
    canPause: true
  });
  if (resolved.value === "approval" || resolved.value === "deny") {
    return "This action needs an approval or is switched off; Always allow cannot change that.";
  }
  return undefined;
}

function viewOf(
  deps: Pick<OperationSettingsDeps, "policy">,
  operation: string,
  definition: OperationDefinition | undefined,
  setting?: { value: PersonPolicySetting; updatedAt: string }
): OperationSettingView | undefined {
  if (!definition) {
    // A setting whose operation is gone stays listed, so the person can remove it.
    return setting
      ? {
          operation,
          effect: "changing",
          value: setting.value,
          mayAlwaysAllow: false,
          updatedAt: setting.updatedAt
        }
      : undefined;
  }
  return {
    operation,
    ...(definition.title ? { title: definition.title } : {}),
    effect: definition.effect,
    ...(definition.effect === "changing" && definition.changeClass
      ? { changeClass: definition.changeClass }
      : {}),
    ...(setting ? { value: setting.value, updatedAt: setting.updatedAt } : {}),
    mayAlwaysAllow: mayAlwaysAllow(definition, deps.policy.alwaysAllowLocked)
  };
}

/**
 * The person's settings, and the operations their agents called in the last 90 days: what a
 * person can be asked about. Sorted by operation name.
 */
export async function listOwnOperationSettings(
  deps: OperationSettingsDeps,
  actor: AuthenticatedIdentity
): Promise<{ items: OperationSettingView[] }> {
  const userId = settingOwner(actor);
  const now = deps.now?.() ?? new Date();
  const [settings, recent] = await Promise.all([
    deps.stores.userOperationSettings.list({ clientInstanceId: deps.clientInstanceId, userId }),
    deps.stores.operationRuns.list({
      clientInstanceId: deps.clientInstanceId,
      filters: {
        actorId: userId,
        originKind: "agent",
        since: new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString()
      },
      page: { limit: RECENT_AGENT_CALLS }
    })
  ]);
  const bySetting = new Map(settings.map((setting) => [setting.operation, setting]));
  const names = [...new Set([...bySetting.keys(), ...recent.map((run) => run.operation)])].sort();
  const views = await Promise.all(
    names.map(async (operation) =>
      viewOf(
        deps,
        operation,
        await deps.registry.resolve(operation).catch(() => undefined),
        bySetting.get(operation)
      )
    )
  );
  return { items: views.filter((view) => view !== undefined) };
}

/**
 * Sets the person's own value for one operation, or removes it with `null`, and records the
 * audit event with the operation and the value alone. "Always allow" is refused where the
 * admin does not permit it or the policy holds the operation at `approval` or `deny`.
 * `stores` may be those of a transaction the decision it comes with is made in.
 */
export async function setOwnOperationSetting(
  deps: OperationSettingsDeps,
  input: {
    actor: AuthenticatedIdentity;
    operation: string;
    value: PersonPolicySetting | null;
    stores?: Pick<PlatformStores, "userOperationSettings">;
  }
): Promise<{ view: OperationSettingView; changed: boolean }> {
  const userId = settingOwner(input.actor);
  const definition = await deps.registry.resolve(input.operation).catch(() => undefined);
  if (!definition && input.value !== null) {
    throw new AppError("VALIDATION_FAILED", `There is no operation '${input.operation}'`, {
      reason: "unknown_operation"
    });
  }
  if (input.value === "always_allow" && definition) {
    const refusal = await alwaysAllowRefusal(deps, definition);
    if (refusal) {
      throw new AppError("FORBIDDEN", refusal, { reason: "always_allow_not_permitted" });
    }
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  const { previous } = await (input.stores ?? deps.stores).userOperationSettings.set({
    clientInstanceId: deps.clientInstanceId,
    userId,
    operation: input.operation,
    value: input.value,
    at
  });
  const view = viewOf(
    deps,
    input.operation,
    definition,
    input.value === null ? undefined : { value: input.value, updatedAt: at }
  ) ?? {
    operation: input.operation,
    effect: "changing" as const,
    mayAlwaysAllow: false
  };
  return { view, changed: previous !== (input.value ?? undefined) };
}

/** The audit event of a changed setting: who, which operation and which value, nothing else. */
export async function recordOperationSettingChanged(
  audit: AuditRecorder,
  input: {
    actor: AuthenticatedIdentity;
    correlationId: string;
    operation: string;
    value: PersonPolicySetting | null;
  }
): Promise<void> {
  await audit.record({
    type: "user.operation_setting_changed",
    status: "success",
    actor: auditActorFromIdentity(input.actor),
    correlationId: input.correlationId,
    subject: settingOwner(input.actor),
    metadata: { operation: input.operation, value: input.value ?? "default" }
  });
}
