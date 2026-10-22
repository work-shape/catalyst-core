import type {
  AgentToolReference,
  AuditActivity as ContractAuditActivity
} from "@work-shape/catalyst-api-contract";
import {
  asCollaborationWorkspaceId,
  asConversationId,
  asUserId,
  auditSubjectOf,
  getSubjectUserId,
  isAppError,
  isAuditAssetKind,
  isBuiltInRole,
  type ActorAccess,
  type AuditActivity,
  type AuditActivityTarget,
  type AuditSubjectReference,
  type AuthenticatedUser,
  type ConfigAssetRecord,
  type JsonObject,
  type LocaleCode
} from "@work-shape/catalyst-core";
import { maySeeAsset } from "../access/principal-grant";
import { accessResource } from "../assets/asset-access";
import { assetTitle } from "../assets/asset-reference-labels";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "../workspaces/workspace-access";

/** What an event or activity is about, as its reader may read it (the contract's `about`). */
interface AuditSubjectWords {
  kind: string;
  title?: string;
  builtInRole?: string;
}

/**
 * Where the subjects are looked up. Each answers what is stored, or nothing; the rights are
 * asked by `withAuditSubjects`, but a workspace answers only one its reader may reach.
 */
export interface AuditSubjectLookups {
  asset(kind: string, name: string): Promise<ConfigAssetRecord | undefined>;
  /** The kind and name of the config asset of the id, deleted ones included. */
  assetById(assetId: string): Promise<{ id: string; kind: string; name: string } | undefined>;
  /** The title of the asset's config in the locale, or its name where it tells none. */
  assetTitle(kind: string, name: string, config: JsonObject, locale: LocaleCode): string;
  /** Whether the kind's module is off, so its assets are not shown. */
  kindOff(kind: string): boolean;
  userName(userId: string): Promise<string | undefined>;
  /** The name of a workspace the reader may reach, else nothing. */
  reachableWorkspaceName(workspaceId: string): Promise<string | undefined>;
  role(roleId: string): Promise<{ name: string; builtIn: boolean } | undefined>;
  conversation(
    conversationId: string
  ): Promise<{ title: string; createdByUserId: string; deletedAt?: string } | undefined>;
  tools(): readonly AgentToolReference[];
}

export interface AuditReader {
  user: AuthenticatedUser;
  access: Pick<ActorAccess, "authorize">;
  locale: LocaleCode;
}

/** The right that opens the people of the instance, and with it their roles (`users.list`). */
const PEOPLE_RIGHT = "users.manage";

/** The lookups of an instance's stores, for the reader of one request. */
export function auditSubjectLookups(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores" | "configAssets" | "modules">,
  user: AuthenticatedUser
): AuditSubjectLookups {
  const { clientInstanceId, stores } = options;
  return {
    asset: (kind, name) =>
      options.configAssets.store.getConfigAsset({ clientInstanceId, kind, name }),
    assetById: async (assetId) =>
      (await stores.access.listGrantScopeAssets({ clientInstanceId, assetIds: [assetId] }))[0],
    assetTitle: (kind, name, config, locale) =>
      assetTitle(options.configAssets.kinds.kinds, kind, name, config, locale),
    kindOff: (kind) => options.modules.offModuleOf("kind", kind) !== undefined,
    userName: async (userId) =>
      (await stores.users.getUser({ clientInstanceId, userId: asUserId(userId) }))?.displayLabel,
    reachableWorkspaceName: async (id) => {
      const workspaceId = asCollaborationWorkspaceId(id);
      try {
        await requireWorkspaceAccess(options, user, workspaceId);
      } catch (error) {
        if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
        throw error;
      }
      return (await stores.workspaces.getWorkspace(clientInstanceId, workspaceId))?.name;
    },
    role: (roleId) => stores.roles.getRole({ clientInstanceId, roleId }),
    conversation: (id) =>
      stores.conversations.getConversation(clientInstanceId, asConversationId(id)),
    tools: () => options.configAssets.tools?.() ?? []
  };
}

/**
 * Says what each activity and each of its events is about in what the reader may read
 * (UXA-1b3): an asset's title, a person's, workspace's or role's name, a tool's title. A
 * subject the reader may not read, or that is gone, keeps only its kind. Each subject is looked
 * up once per answer.
 */
export async function withAuditSubjects(
  lookups: AuditSubjectLookups,
  reader: AuditReader,
  activities: readonly AuditActivity[]
): Promise<ContractAuditActivity[]> {
  const words = new Map<string, Promise<AuditSubjectWords>>();
  const describe = (reference: AuditSubjectReference): Promise<AuditSubjectWords> => {
    const key = JSON.stringify(reference);
    let found = words.get(key);
    if (!found) {
      found = describeSubject(lookups, reader, reference);
      words.set(key, found);
    }
    return found;
  };
  return Promise.all(
    activities.map(async (activity) => {
      const [target, evidence] = await Promise.all([
        activity.target ? targetWithLabel(activity.target, describe) : undefined,
        Promise.all(
          activity.evidence.map(async (event) => {
            const reference = auditSubjectOf(event);
            return reference ? { ...event, about: await describe(reference) } : event;
          })
        )
      ]);
      return { ...activity, ...(target ? { target } : {}), evidence };
    })
  );
}

/** The activity's target with the label its reader may read, or none. */
async function targetWithLabel(
  target: AuditActivityTarget,
  describe: (reference: AuditSubjectReference) => Promise<AuditSubjectWords>
): Promise<AuditActivityTarget> {
  const { label: name, ...rest } = target;
  const reference = targetReference(target.kind, target.id, name);
  const words = reference ? await describe(reference) : undefined;
  return words?.title ? { ...rest, label: words.title } : rest;
}

/** The core's targets: a tool's carries its name as its label until it is said here. */
function targetReference(
  kind: string,
  id: string,
  toolName: string | undefined
): AuditSubjectReference | undefined {
  switch (kind) {
    case "conversation":
      return { kind, conversationId: id };
    case "collaboration_workspace":
      return { kind, workspaceId: id };
    case "user":
      return { kind, userId: id };
    case "tool":
      return { kind: "operation", operation: toolName ?? id };
    default:
      return undefined;
  }
}

async function describeSubject(
  lookups: AuditSubjectLookups,
  reader: AuditReader,
  reference: AuditSubjectReference
): Promise<AuditSubjectWords> {
  const { kind } = reference;
  const title = await titleOf(lookups, reader, reference);
  return { kind, ...title };
}

async function titleOf(
  lookups: AuditSubjectLookups,
  reader: AuditReader,
  reference: AuditSubjectReference
): Promise<Omit<AuditSubjectWords, "kind">> {
  if ("name" in reference && isAuditAssetKind(reference.kind)) {
    return assetWords(lookups, reader, await lookups.asset(reference.kind, reference.name));
  }
  if ("assetId" in reference && isAuditAssetKind(reference.kind)) {
    const asset = await lookups.assetById(reference.assetId);
    if (!asset || asset.kind !== reference.kind) return {};
    const record = await lookups.asset(asset.kind, asset.name);
    return assetWords(lookups, reader, record?.id === asset.id ? record : undefined);
  }
  if ("userId" in reference) {
    const own = getSubjectUserId(reader.user) === reference.userId;
    if (!own && !reader.access.authorize(PEOPLE_RIGHT).allowed) return {};
    const name = await lookups.userName(reference.userId);
    return name ? { title: name } : {};
  }
  if ("workspaceId" in reference) {
    const name = await lookups.reachableWorkspaceName(reference.workspaceId);
    return name ? { title: name } : {};
  }
  if ("roleId" in reference) {
    if (!reader.access.authorize(PEOPLE_RIGHT).allowed) return {};
    const role = await lookups.role(reference.roleId);
    if (role?.builtIn || (!role && isBuiltInRole(reference.roleId))) {
      return { builtInRole: reference.roleId };
    }
    return role ? { title: role.name } : {};
  }
  if ("conversationId" in reference) {
    // A conversation is its author's: whoever reads the audit log reads the title of their own.
    const conversation = await lookups.conversation(reference.conversationId);
    return conversation &&
      !conversation.deletedAt &&
      conversation.createdByUserId === getSubjectUserId(reader.user)
      ? { title: conversation.title }
      : {};
  }
  if ("operation" in reference) {
    // A tool's title is what the agent page shows of it to whoever may edit an agent.
    const tool = lookups.tools().find((each) => each.name === reference.operation);
    const title = tool?.title?.[reader.locale === "de" ? "de" : "en"];
    return title ? { title } : {};
  }
  return {};
}

/** An asset's title, where it is there, its module is on and the reader may read it. */
function assetWords(
  lookups: AuditSubjectLookups,
  reader: AuditReader,
  record: ConfigAssetRecord | undefined
): Omit<AuditSubjectWords, "kind"> {
  if (!record || record.status !== "active" || lookups.kindOff(record.kind)) return {};
  const resource = accessResource(
    record.kind,
    record.name,
    record.scope,
    record.id,
    record.appAvailability
  );
  if (!maySeeAsset(reader.access, resource)) return {};
  return {
    title: lookups.assetTitle(record.kind, record.name, record.config ?? {}, reader.locale)
  };
}
