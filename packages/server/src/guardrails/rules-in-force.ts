import type { RuleInForceView, RulesInForceView } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  GUARDRAIL_ACTIONS,
  GUARDRAIL_ASSET_KIND,
  NOTICE_RECIPIENTS_MAX,
  SHIPPED_GUARDRAILS,
  asUserId,
  authenticatedUserFromRecord,
  isSuperadmin,
  type AccessResource,
  type ActorAccess,
  type AssetScope,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type GuardrailFilter,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  guardrailConfigSchema,
  type ReleaseGuardrailConfig
} from "@work-shape/catalyst-config-schema";
import { createNotices } from "../notices/notices";
import { readInstanceAdminName } from "../users/instance-admin-contact";
import type { ChatServerOptions } from "../types";

// Rules in force (GR-3): the operator's floor, the release's switches and the published
// guardrails that apply to the viewer's workspaces, with who changed each and when, who can
// change it and how often it fired in 30 days. Spec: events-workflows-and-guardrails.md, What a
// stopped person sees.
//
// Names follow the directory rules the instance has: a person is named to a viewer who shares
// a Shared Workspace with them, to themselves, and to a holder of the people right, who sees
// every account. An admin for all workspaces is named in help text, as every refusal does.
// Nobody else is named. Hits are a count by rule: never who was stopped, never what.

type Options = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "config" | "configAssets" | "authorizer" | "auditRecorder"
>;

/** The right that opens every account of the instance, and with it every name. */
const PEOPLE_RIGHT = "users.manage";
/** The most published guardrails the list reads. */
const PUBLISHED_MAX = 1_000;
/** The most people whose rights are read for one list: the bound of one request's work. */
const CANDIDATES_MAX = 200;
/** The most people named as who can change one rule. */
const CHANGERS_NAMED_MAX = 5;

/** One rule as the list holds it, with what the viewer is not shown. */
interface Rule {
  view: Omit<RuleInForceView, "changers" | "changedBy" | "changedByHidden" | "hitsLast30Days">;
  /** Who changed it last, by id: the publisher of the revision or who switched it. */
  changedById?: string;
  /** The scope `guardrail.publish` is asked at. Absent for the floor. */
  publishScope?: AssetScope;
}

/** The rules in force for one viewer, and who of them the viewer may see. */
export async function rulesInForce(
  options: Options,
  viewer: AuthenticatedUser,
  access: Pick<ActorAccess, "authorize">
): Promise<RulesInForceView> {
  const { clientInstanceId, stores } = options;
  const rules = await listRules(options, viewer);
  const visible = await visiblePeople(options, viewer, access);
  const holders = await holdersAmong(options, visible);
  const changersOf = (scope: AssetScope | undefined): string[] =>
    scope
      ? holders(scope)
          .map((person) => person.displayLabel)
          .slice(0, CHANGERS_NAMED_MAX)
      : [];
  const items = await Promise.all(
    rules.map(async (rule): Promise<RuleInForceView> => {
      const counts = await stores.guardrails.countHits({
        clientInstanceId,
        guardrailName: rule.view.name
      });
      const shown = rule.changedById ? visible.get(rule.changedById) : undefined;
      return {
        ...rule.view,
        ...(shown ? { changedBy: shown.displayLabel } : {}),
        ...(rule.changedById && !shown ? { changedByHidden: true as const } : {}),
        changers: changersOf(rule.publishScope),
        hitsLast30Days: counts.last30Days
      };
    })
  );
  const instanceAdmin = await readInstanceAdminName(stores.users, clientInstanceId);
  return { items, ...(instanceAdmin ? { instanceAdmin } : {}) };
}

/**
 * Sends the viewer's question about one rule to the Inbox of who can change it: who changed it
 * last and every holder of `guardrail.publish` at its scope, the viewer left out. The floor is
 * the operator's, and nobody here can change it.
 */
export async function askAboutRule(
  options: Options,
  viewer: AuthenticatedUser,
  from: AuthenticatedIdentity,
  input: { name: string; text: string; locale: string; correlationId: string }
): Promise<{ addressees: number }> {
  const { clientInstanceId, stores } = options;
  const rules = await listRules(options, viewer);
  const rule =
    rules.find((entry) => entry.view.name === input.name && entry.view.origin !== "release") ??
    rules.find((entry) => entry.view.name === input.name);
  if (!rule) throw new AppError("NOT_FOUND", `No rule '${input.name}' is in force for you`);
  if (!rule.publishScope) {
    throw new AppError(
      "CONFLICT",
      "The operator sets this rule; nobody in this instance can change it",
      { reason: "set_by_operator" },
      { exposeMessage: true }
    );
  }
  const people = await activePeople(options);
  const holders = await holdersAmong(
    options,
    new Map(people.filter((person) => person.id !== viewer.id).map((p) => [p.id, p]))
  );
  const to = new Set(holders(rule.publishScope).map((person) => person.id));
  if (
    rule.changedById &&
    rule.changedById !== viewer.id &&
    people.some((person) => person.id === rule.changedById)
  ) {
    to.add(asUserId(rule.changedById));
  }
  const users = [...to].slice(0, NOTICE_RECIPIENTS_MAX);
  if (users.length === 0) {
    throw new AppError(
      "CONFLICT",
      "Nobody who can change this rule can be asked",
      { reason: "nobody_to_ask" },
      { exposeMessage: true }
    );
  }
  const notices = createNotices({
    clientInstanceId,
    stores,
    auditRecorder: options.auditRecorder
  });
  const title = rule.view.displayName;
  const sent = await notices.send(
    {
      from,
      to: { users },
      title: (input.locale === "de"
        ? `Frage zur Leitplanke „${title}“`
        : `Question about the guardrail “${title}”`
      ).slice(0, 120),
      text: input.text,
      channels: ["inbox"]
    },
    { correlationId: input.correlationId }
  );
  return { addressees: sent.addressees };
}

/** The rules that apply to the viewer's workspaces, the floor first. */
async function listRules(options: Options, viewer: AuthenticatedUser): Promise<Rule[]> {
  const { clientInstanceId, stores } = options;
  const workspaces = await stores.workspaces.listWorkspacesForUser({
    clientInstanceId,
    userId: asUserId(viewer.id)
  });
  const workspaceNames = new Map(
    workspaces.map((workspace) => [String(workspace.id), workspace.name])
  );
  const floor = Object.entries(options.config.guardrails).map(([name, guardrail]): Rule => ({
    view: {
      name,
      displayName: guardrail.displayName ?? name,
      reason: reasonOf(guardrail),
      on: [guardrail.on],
      ...filterView(guardrail.filter),
      checkKind: guardrail.check.kind,
      outcome: guardrail.outcome,
      origin: "release",
      scope: { kind: "instance" },
      askable: false
    }
  }));
  const switches = await stores.guardrails.listShippedGuardrailSwitches({ clientInstanceId });
  const shipped = SHIPPED_GUARDRAILS.map((guardrail): Rule => {
    const switched = switches.find((entry) => entry.name === guardrail.name);
    return {
      view: {
        name: guardrail.name,
        displayName: guardrail.displayName,
        reason: guardrail.reason,
        on: [...guardrail.on],
        outcome: guardrail.outcome,
        origin: "shipped",
        scope: { kind: "instance" },
        enabled: switched?.enabled ?? true,
        ...(guardrail.asksOnlyWhenWidening ? { alwaysAsk: switched?.alwaysAsk ?? false } : {}),
        ...(switched ? { changedAt: switched.switchedAt } : {}),
        askable: true
      },
      ...(switched ? { changedById: switched.switchedBy.id } : {}),
      publishScope: { kind: "instance" }
    };
  });
  const records = await options.configAssets.store.listPublishedConfigAssets({
    clientInstanceId,
    kind: GUARDRAIL_ASSET_KIND,
    limit: PUBLISHED_MAX
  });
  const published = await Promise.all(
    records.map(async (record): Promise<Rule | undefined> => {
      const parsed = guardrailConfigSchema.safeParse(record.publishedConfig);
      if (!parsed.success || parsed.data.origin !== "asset") return undefined;
      if (record.publishedRevision === undefined) return undefined;
      const { scope } = record;
      if (scope.kind === "workspace" && !workspaceNames.has(String(scope.workspaceId))) {
        return undefined;
      }
      const guardrail = parsed.data;
      const [publication] = await options.configAssets.store.listConfigAssetPublications({
        clientInstanceId,
        assetId: record.id,
        page: { limit: 1 }
      });
      const live = publication?.revision === record.publishedRevision ? publication : undefined;
      return {
        view: {
          name: guardrail.name,
          displayName: guardrail.displayName,
          reason: reasonOf(guardrail),
          on: [guardrail.on],
          ...filterView(guardrail.filter),
          checkKind: guardrail.check.kind,
          outcome: guardrail.outcome,
          origin: "asset",
          scope:
            scope.kind === "workspace"
              ? {
                  kind: "workspace",
                  workspaceId: String(scope.workspaceId),
                  workspaceName: workspaceNames.get(String(scope.workspaceId)) ?? ""
                }
              : { kind: "instance" },
          revision: record.publishedRevision,
          ...(live?.publishedAt ? { changedAt: live.publishedAt } : {}),
          askable: true
        },
        ...(live?.actor?.userId ? { changedById: live.actor.userId } : {}),
        publishScope: scope
      };
    })
  );
  return [...floor, ...shipped, ...published.filter((rule): rule is Rule => rule !== undefined)];
}

/** The reason a person is told, where the rule words one; a judge words its own. */
function reasonOf(guardrail: Pick<ReleaseGuardrailConfig, "check" | "description">): string {
  if (guardrail.check.kind === "pattern" && guardrail.check.reason) return guardrail.check.reason;
  return guardrail.description ?? "";
}

function filterView(filter: GuardrailFilter | undefined): Pick<RuleInForceView, "filter"> {
  const entries = Object.entries(filter ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? { filter: Object.fromEntries(entries) } : {};
}

/** The active people of the instance, superadmins among them, at most the bound. */
async function activePeople(options: Options): Promise<UserRecord[]> {
  return options.stores.users.listUsers({
    clientInstanceId: options.clientInstanceId,
    activeOnly: true,
    page: { limit: CANDIDATES_MAX }
  });
}

/**
 * The people the viewer may see named, by id: everyone for a holder of the people right, else
 * the viewer and their co-members of Shared Workspaces. A superadmin is named to a superadmin
 * only, as the access pages do. An account without a person's name is never named.
 */
async function visiblePeople(
  options: Options,
  viewer: AuthenticatedUser,
  access: Pick<ActorAccess, "authorize">
): Promise<Map<string, UserRecord>> {
  const { clientInstanceId, stores } = options;
  const shown = new Map<string, UserRecord>();
  const add = (person: UserRecord | undefined) => {
    if (!person || person.status !== "active") return;
    if (!person.displayLabel.trim() || person.displayLabel.includes("@")) return;
    if (isSuperadmin(person) && !isSuperadmin(viewer) && person.id !== viewer.id) return;
    if (shown.size < CANDIDATES_MAX) shown.set(person.id, person);
  };
  if (access.authorize(PEOPLE_RIGHT).allowed) {
    for (const person of await activePeople(options)) add(person);
    return shown;
  }
  add(await stores.users.getUser({ clientInstanceId, userId: asUserId(viewer.id) }));
  const workspaces = await stores.workspaces.listWorkspacesForUser({
    clientInstanceId,
    userId: asUserId(viewer.id)
  });
  for (const workspace of workspaces.filter((entry) => entry.kind === "shared")) {
    const members = await stores.workspaces.listMemberships({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id
    });
    for (const member of members) {
      if (shown.has(member.userId)) continue;
      add(await stores.users.getUser({ clientInstanceId, userId: member.userId }));
      if (shown.size >= CANDIDATES_MAX) return shown;
    }
  }
  return shown;
}

/**
 * Who of these people holds `guardrail.publish` at a scope, in the order of their names. Each
 * person's rights are read once, however many scopes are asked.
 */
async function holdersAmong(
  options: Options,
  people: ReadonlyMap<string, UserRecord>
): Promise<(scope: AssetScope) => UserRecord[]> {
  const { authorizer } = options;
  if (!authorizer) return () => [];
  const accessOf = new Map<string, Pick<ActorAccess, "authorize">>();
  for (const person of people.values()) {
    try {
      const actor = authenticatedUserFromRecord({
        user: person,
        identity: { authSource: "rules-in-force", externalUserId: person.id }
      });
      accessOf.set(person.id, await authorizer.forActor(actor));
    } catch {
      // An account that cannot act holds nothing.
    }
  }
  const sorted = [...people.values()].sort((left, right) =>
    left.displayLabel.localeCompare(right.displayLabel)
  );
  return (scope) => {
    const resource: AccessResource =
      scope.kind === "workspace"
        ? { kind: GUARDRAIL_ASSET_KIND, workspaceId: scope.workspaceId }
        : { kind: GUARDRAIL_ASSET_KIND };
    return sorted.filter(
      (person) => accessOf.get(person.id)?.authorize(GUARDRAIL_ACTIONS.publish, resource).allowed
    );
  };
}
