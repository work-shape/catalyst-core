import type { AssetScope, RegisteredAssetKind } from "./asset-kinds";
import type { AuthenticatedIdentity } from "./identity";
import type { ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";
import type { ActorAccess } from "./permissions";
import type { PlatformStores } from "./platform-store";

/**
 * What a kind answers of its own writes and publishes beyond its definition: the checks only
 * the kind knows. A capability's kind brings these alone; the platform answers the rest as it
 * does for a kind without them.
 */
export interface CapabilityAssetKindChecks {
  /**
   * Every asset the definition names, including operation targets. The common save and
   * publish checks use this one inventory for reference resolution and owner boundaries.
   * Kinds with no references return an empty list.
   */
  references?(definition: unknown): readonly { kind: string; name: string }[];
  /**
   * Throws where the stored asset may not be changed through any asset operation, whatever
   * the caller sends and whoever calls: an asset that release config defines. It is asked of
   * what is stored before the write is read, so its refusal comes before every other one.
   */
  assertStoredWritable?(input: { current: unknown }): void;
  /**
   * Throws where this caller may not make this revision the one the asset's users are served,
   * whatever the kind's publish right says: the revision lends something its writer could not
   * give, such as the grants of the service principal a Workflow runs as. It is asked of the
   * revision that becomes live and of who makes it so: on a publish, of the newest revision
   * and of an earlier one alike. Who wrote the revision is not asked. Only a kind with the
   * lifecycle `draft_published` may set it, and the registry refuses any other: there a
   * revision goes live by a publish and by nothing else, and a delete takes the published
   * revision away, so a deleted asset that is written again is a draft.
   */
  authorizeLive?(input: {
    actor: AuthenticatedIdentity;
    access: ActorAccess;
    name: string;
    /** The revision that becomes live. */
    revision: number;
    /** The config of that revision. */
    config: unknown;
  }): void | Promise<void>;
  /**
   * Throws where a write of the validated definition reaches beyond the scope that owns the
   * asset, which only the stores can tell: a workspace guardrail whose filter names another
   * workspace. Asked of every write through an asset operation, before it is stored.
   */
  assertScopedWrite?(input: {
    clientInstanceId: ClientInstanceId;
    scope: AssetScope;
    name: string;
    definition: unknown;
    stores: PlatformStores;
    /** Who writes it: what a definition may name can depend on what they may see. */
    actor: AuthenticatedIdentity;
  }): Promise<void>;
  /**
   * What a publish does beside moving the published pointer, with `stores` bound to the
   * transaction that moves it. A throw refuses the publish and leaves the pointer where it was.
   */
  onPublish?(input: {
    actor: AuthenticatedIdentity;
    revisionId: string;
    clientInstanceId: ClientInstanceId;
    /** What the caller of the publish may do: a kind asks it for what the revision reaches. */
    access: ActorAccess;
    assetId: string;
    /** The owner of the asset: what it names of other assets is read in this scope. */
    scope: AssetScope;
    revision: number;
    config: JsonObject;
    /** The config that was published until this publish, where one was. */
    replaced?: JsonObject;
    confirmProcessing?: string;
    stores: PlatformStores;
  }): Promise<void>;
}

/**
 * An asset kind a capability brings: the kind as the registry holds it, with the checks of
 * its writes that only it knows. The platform registers it while the capability's module is
 * on, and answers everything else of it as for a kind with no default asset, no workspace
 * availability and no editing policy of its own.
 */
export type CapabilityAssetKind = RegisteredAssetKind & CapabilityAssetKindChecks;
