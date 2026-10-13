import { z } from "zod";
import type { ConfigAssetRecord, UserRecord } from "@vivd-catalyst/core";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  skill,
  storeTestServicePrincipal,
  type AccessInstance,
  type AccessInstanceOptions
} from "./access-instance";
import { applyAtCurrentRevisions } from "./asset-revisions";

// What the tests of a release through `assets.sync` share: the service principal that holds
// the release right, the items of a batch, and how a refused batch reads.

/** The Namespace the assets of these tests lie in, which a batch of an ordinary caller names. */
const NAMESPACE = "rel-";
export const SERVICE = "sp_test";
/** The limits of an instance that is edited by release only, but for the display name. */
export const RELEASE_ONLY = {
  editableAgentFields: ["displayName"],
  allowAgentCreation: false,
  allowAgentDeletion: false,
  allowSkillEditing: false
};

const refusalSchema = z.object({
  items: z.array(
    z.object({
      index: z.number(),
      name: z.string().optional(),
      status: z.enum(["refused", "not_applied"]),
      error: z
        .object({ code: z.string(), message: z.string(), action: z.string().optional() })
        .optional()
    })
  )
});

export type Item = Record<string, unknown>;
/** A put at the revision the test names. Without one it creates the asset. */
export const putAgent = (
  name: string,
  overrides: Item = {},
  expectedRevision: number | null = null
): Item => ({ type: "put", kind: "agent", config: agent(name, overrides), expectedRevision });
export const putSkill = (
  name: string,
  content: string,
  expectedRevision: number | null = null
): Item => ({ type: "put", kind: "skill", config: skill(name, content), expectedRevision });
export const deleteAgent = (name: string, expectedRevision = 1): Item => ({
  type: "delete",
  kind: "agent",
  name,
  expectedRevision
});

export interface ReleaseInstance extends AccessInstance {
  /** An administrator who also holds the release right. */
  releaser: UserRecord;
  stored(kind: string, name: string): Promise<ConfigAssetRecord | undefined>;
  /** The version of the instance's assets. */
  version(): Promise<number>;
}

export async function setupRelease(options: AccessInstanceOptions = {}): Promise<ReleaseInstance> {
  const t = await setupAccessInstance(options);
  await storeTestServicePrincipal(SERVICE);
  await t.createNamespace(NAMESPACE);
  // An administrator who also holds the release right: bound outside a sync like anyone.
  const releaser = await t.stores.users.createUser({
    clientInstanceId,
    displayLabel: "Releaser",
    roles: ["user", "admin"],
    permissions: ["config_assets.release"]
  });
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "agent", name: "rel-old", config: agent("rel-old") },
      { type: "upsert", kind: "skill", name: "rel-guide", config: skill("rel-guide") }
    ]
  });
  const stored = (kind: string, name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  const version = async () =>
    (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).version;
  return { ...t, releaser, stored, version };
}

/** A call of the service principal, with the scopes of its key where the test names them. */
export function asService(
  t: AccessInstance,
  operation: Parameters<AccessInstance["call"]>[1],
  input: Parameters<AccessInstance["instance"]["call"]>[1],
  scopes?: string
): ReturnType<AccessInstance["call"]> {
  return t.instance.call(operation, {
    ...input,
    headers: {
      ...input?.headers,
      [SERVICE_HEADER]: SERVICE,
      ...(scopes ? { [SCOPES_HEADER]: scopes } : {})
    }
  });
}

type Answer = ReturnType<AccessInstance["call"]>;
export const syncAsService = (t: AccessInstance, items: Item[], scopes?: string): Answer =>
  asService(t, "assets.sync", { payload: { items } }, scopes);
/** A batch with what it names beside its items, such as the default agent. */
export const releaseAsService = (t: AccessInstance, payload: Item): Answer =>
  asService(t, "assets.sync", { payload });
export const syncAs = (t: AccessInstance, userId: string, items: Item[], more: Item = {}): Answer =>
  t.call(userId, "assets.sync", { payload: { namespace: NAMESPACE, items, ...more } });

export function refusedItems(response: { json(): unknown }) {
  const { error } = errorSchema.parse(response.json());
  return {
    code: error.code,
    items: refusalSchema.parse(error.details).items.map((item) => ({
      name: item.name,
      status: item.status,
      ...(item.error ? { code: item.error.code, message: item.error.message } : {}),
      ...(item.error?.action ? { action: item.error.action } : {})
    }))
  };
}
